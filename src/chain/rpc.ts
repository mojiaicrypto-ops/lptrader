/**
 * §99 multi-RPC access with failover and cross-check.
 *
 * Why this is a separate module rather than a `viem` transport setting:
 *
 * - `viem`'s `fallback()` transport fails over on transport errors, but a *JSON-RPC error* (a
 *   business-level answer, e.g. an `eth_call` revert) is not a transport error and must NOT trigger
 *   failover to a second node. This module classifies the two cases explicitly.
 * - §99 additionally requires that critical reads (balances, tick, liquidity) are **cross-checked**
 *   between endpoints: a silent disagreement between two nodes is exactly the situation where
 *   "take the first answer" is the wrong behaviour, so a mismatch throws `CrossCheckError` and the
 *   caller concludes nothing.
 *
 * A failed read is never retried against the *same* endpoint with different semantics: the adapter
 * either gets a consistent answer or raises (§96 Fail Closed).
 */
import { createPublicClient, custom, http, type PublicClient, type Transport } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import type { Address, ChainId } from '../types/primitives.ts';
import {
  ChainError,
  CHAIN_ERROR_CODES,
  CrossCheckError,
  RpcNodeError,
  RpcUnavailableError,
} from './errors.ts';

/** Chain definitions this project can talk to. BNB Chain is the only whitelisted one (§11). */
export const CHAIN_DEFINITIONS = {
  56: bsc,
  97: bscTestnet,
} as const;

/** Multicall3 is deployed at the same address on both BSC chains (research §5). */
export const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11' as Address;

/**
 * Endpoints used when `.env` supplies none. These are public, read-only archives-capable endpoints;
 * a production run must override them (`.env.example` documents `BSC_RPC_URL` /
 * `BSC_RPC_URL_SECONDARY`).
 */
export const DEFAULT_BSC_RPC_URLS: readonly string[] = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
];

export interface RpcEndpointSpec {
  /** Human-readable label used in error messages and cross-check reports (never a secret). */
  readonly label: string;
  readonly url: string;
}

export interface RpcEndpointOptions {
  /** Explicit endpoint list; when omitted the environment is consulted, then the defaults. */
  readonly endpoints?: readonly RpcEndpointSpec[];
  readonly env?: NodeJS.ProcessEnv;
  /**
   * §99 cross-check pairs. Critical reads are executed on the first N endpoints and must agree.
   * Defaults to `min(2, endpoints.length)`; `1` disables cross-checking (single-endpoint mode).
   */
  readonly crossCheckEndpoints?: number;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Total attempts per endpoint for transport-level failures. */
  readonly retries?: number;
  /** Injected for tests: replaces the real HTTP transport factory. */
  readonly transportFactory?: (endpoint: RpcEndpointSpec) => Transport;
}

/** Provenance for a value that may or may not have been cross-checked. */
export interface RpcProvenance {
  /** Endpoint labels that contributed to (and agreed on) the value. */
  readonly observedBy: readonly string[];
  /**
   * True when fewer than two endpoints could confirm the value. The read is still *from chain*, but
   * §99's "two independent nodes agree" guarantee does not hold, so risk-critical consumers may
   * choose to reject it.
   */
  readonly degraded: boolean;
}

export interface RpcReadResult<T> {
  readonly value: T;
  readonly provenance: RpcProvenance;
}

interface Endpoint {
  readonly spec: RpcEndpointSpec;
  readonly client: PublicClient;
  /** Chain id as reported by the endpoint; `null` until verified. */
  reportedChainId: number | null;
}

/** Classify a thrown value into "the node answered" vs "the transport/endpoint failed". */
interface NodeLevelFailure {
  readonly kind: 'node-error';
  readonly rpcCode: number;
  readonly data: string | undefined;
  readonly message: string;
}

function classify(error: unknown): NodeLevelFailure | { readonly kind: 'transport'; readonly message: string } {
  const chain: unknown[] = [];
  let cursor: unknown = error;
  for (let depth = 0; cursor !== undefined && cursor !== null && depth < 8; depth += 1) {
    chain.push(cursor);
    cursor = (cursor as { cause?: unknown }).cause;
  }

  // A JSON-RPC error object anywhere in the cause chain means the endpoint served the request and
  // the request itself failed (revert, out-of-gas, bad params). Failover would just repeat it.
  for (const link of chain) {
    if (typeof link !== 'object' || link === null) continue;
    const candidate = link as { code?: unknown; data?: unknown; message?: unknown };
    if (typeof candidate.code === 'number' && candidate.code > 0 && candidate.code !== 4001) {
      // viem wraps JSON-RPC errors with the raw `code`; `-1` is viem's own "unknown RPC error".
      if (candidate.code !== -1) {
        return {
          kind: 'node-error',
          rpcCode: candidate.code,
          data: typeof candidate.data === 'string' ? candidate.data : undefined,
          message: typeof candidate.message === 'string' ? candidate.message : 'rpc error',
        };
      }
    }
  }

  // viem's `ExecutionRevertedError`/`CallExecutionError` wrap a raw node error; when the raw error
  // does not carry a numeric `code` the revert detail is only in the message.
  for (const link of chain) {
    if (typeof link !== 'object' || link === null) continue;
    const name = (link as { name?: unknown }).name;
    if (name === 'ExecutionRevertedError' || name === 'ContractFunctionRevertedError') {
      return { kind: 'node-error', rpcCode: 3, data: undefined, message: 'execution reverted' };
    }
  }

  return {
    kind: 'transport',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Default transport: viem's HTTP transport, with a hard timeout and a caller-controlled retry count.
 *
 * Why not a hand-rolled `custom()` fetch wrapper: with `custom()`, a thrown plain `Error` is
 * re-wrapped by viem as `UnknownRpcError` (`code: -1`), and `code: -1` is on viem's *retryable* list.
 * A plain contract revert would then be retried four times with exponential backoff (~1s and four
 * `eth_call`s per probe) before surfacing. `http()` raises a typed `RpcRequestError` carrying the
 * node's real `code`/`data`, so a revert stays a revert: one call, no failover, no retry storm.
 */
function defaultTransport(
  endpoint: RpcEndpointSpec,
  timeoutMs: number,
  retries: number | undefined,
): Transport {
  return http(endpoint.url, {
    timeout: timeoutMs,
    ...(retries === undefined ? {} : { retryCount: retries }),
    // A failed endpoint must be replaced by the next endpoint in the §99 pool, not retried silently
    // by the transport. Retries stay low so one dead endpoint cannot stall a monitor tick.
    retryDelay: 250,
  });
}

/**
 * Structural equality for §99 cross-check values.
 *
 * Scalar reads compare as expected, and batched reads (arrays of `bigint` from `aggregate3`) compare
 * element-wise instead of by reference. Comparing by reference would make every batched read look
 * like a cross-check failure, which would be an outage disguised as a safety feature.
 */
function deepEqualValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'bigint' || typeof b === 'bigint') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqualValues(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => deepEqualValues(left[key], right[key]));
  }
  return false;
}

/**
 * §99 chain access. One instance per process; it owns the endpoint pool, the failover order and the
 * cross-check policy.
 *
 * LIFECYCLE: `getEndpointCount()`/`provenance` are the only state; nothing is cached across calls,
 * so a monitor tick always reads fresh chain state.
 */
export class RpcPool {
  readonly chainId: ChainId;
  private readonly endpoints: readonly Endpoint[];
  private readonly crossCheckEndpoints: number;
  private readonly transportFactory: (endpoint: RpcEndpointSpec) => Transport;

  constructor(chainId: ChainId, options: RpcEndpointOptions = {}) {
    const chain = CHAIN_DEFINITIONS[chainId as keyof typeof CHAIN_DEFINITIONS];
    if (chain === undefined) {
      throw new ChainError(
        CHAIN_ERROR_CODES.CHAIN_NOT_WHITELISTED,
        `no chain definition for chainId ${chainId}; supported: ${Object.keys(CHAIN_DEFINITIONS).join(', ')}`,
        { chainId },
      );
    }

    const specs = resolveEndpoints(options, chainId);
    const timeoutMs = options.timeoutMs ?? 15_000;
    const makeTransport =
      options.transportFactory ??
      ((endpoint: RpcEndpointSpec) => defaultTransport(endpoint, timeoutMs, options.retries));
    this.transportFactory = makeTransport;

    this.chainId = chainId;
    this.endpoints = specs.map((spec) => ({
      spec,
      client: createPublicClient({
        chain,
        transport: makeTransport(spec),
        ...(options.retries === undefined ? {} : { retryCount: options.retries }),
      }) as PublicClient,
      reportedChainId: null,
    }));
    this.crossCheckEndpoints = Math.max(
      1,
      Math.min(options.crossCheckEndpoints ?? 2, this.endpoints.length),
    );
  }

  /**
   * The transport backing the primary endpoint.
   *
   * A wallet client must write through the *same* endpoint ordering the reads use, otherwise a
   * write could be broadcast to a node that a later read never consults. Constructing it from the
   * stored endpoint spec (rather than reusing `primary.transport`) keeps the injected
   * `transportFactory` in effect for tests.
   */
  get primaryTransport(): Transport {
    const endpoint = this.endpoints[0];
    if (endpoint === undefined) {
      throw new RpcUnavailableError('no RPC endpoint configured');
    }
    return this.transportFactory(endpoint.spec);
  }

  getEndpointCount(): number {
    return this.endpoints.length;
  }

  getEndpointLabels(): readonly string[] {
    return this.endpoints.map((endpoint) => endpoint.spec.label);
  }

  /** Primary client (first endpoint). Used only for calls that need a single node. */
  get primary(): PublicClient {
    const endpoint = this.endpoints[0];
    if (endpoint === undefined) {
      throw new RpcUnavailableError('no RPC endpoint configured');
    }
    return endpoint.client;
  }

  /** Each endpoint's client, in priority order. Callers that batch should use `runOnEndpoint`. */
  get clients(): readonly PublicClient[] {
    return this.endpoints.map((endpoint) => endpoint.client);
  }

  /**
   * Execute `operation` against one endpoint, verifying its chain id first. The chain-id guard is
   * what makes failover safe: a misconfigured endpoint for another network would otherwise answer
   * every read with plausible-looking garbage.
   */
  private async attempt<T>(endpoint: Endpoint, operation: (client: PublicClient) => Promise<T>): Promise<T> {
    if (endpoint.reportedChainId === null) {
      const reported = await endpoint.client.getChainId();
      if (reported !== this.chainId) {
        throw new ChainError(
          CHAIN_ERROR_CODES.CHAIN_ID_MISMATCH,
          `RPC endpoint ${endpoint.spec.label} reports chainId ${reported}, expected ${this.chainId}`,
          { endpoint: endpoint.spec.label, reported, expected: this.chainId },
        );
      }
      endpoint.reportedChainId = reported;
    }
    return operation(endpoint.client);
  }

  /**
   * Run a read on the first endpoint that can serve it, failing over on transport failures only.
   *
   * @throws RpcUnavailableError when no endpoint could serve the request
   * @throws RpcNodeError when the endpoint served it and the call itself failed
   */
  async call<T>(operation: (client: PublicClient) => Promise<T>, method: string): Promise<RpcReadResult<T>> {
    const failures: string[] = [];
    for (const endpoint of this.endpoints) {
      try {
        const value = await this.attempt(endpoint, operation);
        return {
          value,
          provenance: { observedBy: [endpoint.spec.label], degraded: true },
        };
      } catch (error) {
        if (error instanceof ChainError) {
          // Chain-id mismatch is fatal by construction: retrying another endpoint is allowed, but we
          // must never report the mismatched node's data. Record it and continue.
          failures.push(`${endpoint.spec.label}: ${error.message}`);
          continue;
        }
        const verdict = classify(error);
        if (verdict.kind === 'node-error') {
          throw new RpcNodeError(
            `${method} failed on ${endpoint.spec.label}: ${verdict.message}`,
            verdict.rpcCode,
            verdict.data,
            { endpoint: endpoint.spec.label, method },
          );
        }
        failures.push(`${endpoint.spec.label}: ${verdict.message}`);
      }
    }
    throw new RpcUnavailableError(
      `${method} could not be served by any RPC endpoint (${this.endpoints.length} tried): ${failures.join(' | ')}`,
      { method, failures },
    );
  }

  /**
   * §99 critical read: every one of the first `crossCheckEndpoints` endpoints is queried and all
   * answers must be **equal** under `compare`.
   *
   * - A mismatch throws `CrossCheckError`; no value is returned at all (fail closed).
   * - If an endpoint cannot answer (transport failure) it is skipped; that downgrades the result to
   *   `degraded: true` rather than failing the read, because losing a *redundant* endpoint must not
   *   take the bot down. A node-level error (revert) is returned immediately: it is a property of
   *   the contract, not the node.
   */
  async crossCheck<T>(
    operation: (client: PublicClient) => Promise<T>,
    method: string,
    options: {
      readonly compare?: (a: T, b: T) => boolean;
      readonly render?: (value: T) => string;
    } = {},
  ): Promise<RpcReadResult<T>> {
    // Structural equality: batched reads return arrays/tuples, and identity comparison would report
    // every batched read as a cross-check mismatch.
    const compare = options.compare ?? deepEqualValues;
    const render: (value: T) => string =
      options.render ??
      ((value) =>
        typeof value === 'string'
          ? value
          : typeof value === 'bigint'
            ? value.toString()
            : JSON.stringify(value, (_key, item) =>
                typeof item === 'bigint' ? item.toString() : item,
              ));
    const candidates = this.endpoints.slice(0, this.crossCheckEndpoints);

    const observations: { endpoint: string; value: T }[] = [];
    const failures: string[] = [];

    for (const endpoint of candidates) {
      try {
        const value = await this.attempt(endpoint, operation);
        observations.push({ endpoint: endpoint.spec.label, value });
      } catch (error) {
        if (error instanceof ChainError) {
          failures.push(`${endpoint.spec.label}: ${error.message}`);
          continue;
        }
        const verdict = classify(error);
        if (verdict.kind === 'node-error') {
          throw new RpcNodeError(
            `${method} failed on ${endpoint.spec.label}: ${verdict.message}`,
            verdict.rpcCode,
            verdict.data,
            { endpoint: endpoint.spec.label, method },
          );
        }
        failures.push(`${endpoint.spec.label}: ${verdict.message}`);
      }
    }

    if (observations.length === 0) {
      throw new RpcUnavailableError(
        `${method} cross-check found no answering RPC endpoint: ${failures.join(' | ')}`,
        { method, failures },
      );
    }

    const reference = observations[0];
    if (reference === undefined) {
      throw new RpcUnavailableError(`${method}: no observation recorded`, { method });
    }
    for (const observation of observations.slice(1)) {
      if (!compare(reference.value, observation.value)) {
        throw new CrossCheckError(
          method,
          observations.map((entry) => ({ endpoint: entry.endpoint, value: render(entry.value) })),
        );
      }
    }

    return {
      value: reference.value,
      provenance: {
        observedBy: observations.map((observation) => observation.endpoint),
        degraded: observations.length < this.crossCheckEndpoints,
      },
    };
  }
}

/**
 * Endpoint resolution order (§99 + `.env.example`):
 * `options.endpoints` → `BSC_RPC_URL` + `BSC_RPC_URL_SECONDARY`(+`…_TERTIARY`) → public defaults.
 * Duplicate URLs (dedup after normalising the trailing slash) are collapsed so a copy-pasted
 * `.env` cannot fake a cross-check against the same node twice.
 */
export function resolveEndpoints(
  options: RpcEndpointOptions,
  chainId: ChainId = 56,
): readonly RpcEndpointSpec[] {
  if (options.endpoints !== undefined && options.endpoints.length > 0) {
    return dedupe(options.endpoints);
  }

  const env = options.env ?? process.env;
  const keys =
    chainId === 56
      ? ['BSC_RPC_URL', 'BSC_RPC_URL_SECONDARY', 'BSC_RPC_URL_TERTIARY']
      : [`BSC_RPC_URL_${chainId}`, 'BSC_RPC_URL_SECONDARY'];

  const fromEnv: RpcEndpointSpec[] = [];
  for (const key of keys) {
    const url = env[key];
    if (url !== undefined && url.trim().length > 0) {
      fromEnv.push({ label: key, url: url.trim() });
    }
  }
  if (fromEnv.length > 0) {
    return dedupe(fromEnv);
  }

  return DEFAULT_BSC_RPC_URLS.map((url, index) => ({ label: `default#${index + 1}`, url }));
}

function dedupe(endpoints: readonly RpcEndpointSpec[]): readonly RpcEndpointSpec[] {
  const seen: Record<string, true> = {};
  const result: RpcEndpointSpec[] = [];
  for (const endpoint of endpoints) {
    const key = endpoint.url.replace(/\/+$/u, '').toLowerCase();
    if (seen[key] === true) continue;
    seen[key] = true;
    result.push(endpoint);
  }
  return result;
}

/**
 * Build a viem transport from an in-memory JSON-RPC handler; used by tests and scripts.
 *
 * `retryCount: 0` is forced: viem's `custom()` re-wraps thrown application errors as
 * `UnknownRpcError` (`code: -1`), which is on its retryable list — so a mock revert would be retried
 * with exponential backoff (~1s). The behaviour under test is the *pool's* failover and cross-check,
 * not viem's internal retry loop.
 */
export function handlerTransport(
  handler: (request: { method: string; params?: unknown }) => Promise<unknown>,
): Transport {
  return custom({ request: handler as Parameters<typeof custom>[0]['request'] }, { retryCount: 0 });
}
