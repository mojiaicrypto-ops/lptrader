/**
 * Errors thrown by the chain layer.
 *
 * Every one of them is a *hard* failure: the chain layer never substitutes a plausible value for
 * a failed read (§96 Fail Closed). The `code` is stable so callers and tests can branch on it
 * without matching message text.
 */

export const CHAIN_ERROR_CODES = {
  /** A configured chain id is not in the chain whitelist (§11). */
  CHAIN_NOT_WHITELISTED: 'CHAIN_NOT_WHITELISTED',
  /** A DEX is not whitelisted for this chain (§12). */
  DEX_NOT_WHITELISTED: 'DEX_NOT_WHITELISTED',
  /** No RPC endpoint answered; nothing can be read, so nothing may be concluded. */
  RPC_UNAVAILABLE: 'RPC_UNAVAILABLE',
  /** The endpoint answered with a JSON-RPC error (e.g. `eth_call` revert). */
  RPC_NODE_ERROR: 'RPC_NODE_ERROR',
  /** An endpoint reports a different chain id than the adapter is bound to. */
  CHAIN_ID_MISMATCH: 'CHAIN_ID_MISMATCH',
  /** Primary and secondary returned different values for a critical read (§99). */
  CROSS_CHECK_MISMATCH: 'CROSS_CHECK_MISMATCH',
  /** §95 pre-flight verification refused the transaction. */
  TX_GUARD_FAILED: 'TX_GUARD_FAILED',
  /** §98: the transaction state could not be determined; it must never be auto-retried. */
  TX_STATE_UNKNOWN: 'TX_STATE_UNKNOWN',
  /** The requested contract/token is not in the address whitelist (§8). */
  ADDRESS_NOT_WHITELISTED: 'ADDRESS_NOT_WHITELISTED',
  /** A response could not be decoded into the expected shape. */
  DECODE_FAILED: 'DECODE_FAILED',
  /** Invalid arguments supplied by the caller. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
} as const;
export type ChainErrorCode = (typeof CHAIN_ERROR_CODES)[keyof typeof CHAIN_ERROR_CODES];

export class ChainError extends Error {
  readonly code: ChainErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: ChainErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    this.context = context;
  }
}

/** Raised when every configured RPC endpoint failed for a request. */
export class RpcUnavailableError extends ChainError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(CHAIN_ERROR_CODES.RPC_UNAVAILABLE, message, context);
    this.name = 'RpcUnavailableError';
  }
}

/** A well-formed JSON-RPC error response (the node answered; the call itself failed). */
export class RpcNodeError extends ChainError {
  readonly rpcCode: number;
  readonly data: string | undefined;

  constructor(
    message: string,
    rpcCode: number,
    data: string | undefined,
    context: Record<string, unknown> = {},
  ) {
    super(CHAIN_ERROR_CODES.RPC_NODE_ERROR, message, context);
    this.name = 'RpcNodeError';
    this.rpcCode = rpcCode;
    this.data = data;
  }

  /**
   * True when the node rejected the call rather than failing to serve it. `eth_call` revert data is
   * `0x`, empty, or an `Error(string)`/`Panic(uint256)` payload — never a transport problem.
   */
  get isRevert(): boolean {
    return this.data === undefined || this.data === '0x' || this.data.startsWith('0x08c379a0') ||
      this.data.startsWith('0x4e487b71');
  }
}

/**
 * §99 cross-check failure. Primary and secondary disagreed on a critical read, so *neither* value
 * may be used: a disagreement means at least one node is lying, stale or misconfigured.
 */
export class CrossCheckError extends ChainError {
  readonly method: string;
  readonly observations: readonly { readonly endpoint: string; readonly value: string }[];

  constructor(
    method: string,
    observations: readonly { readonly endpoint: string; readonly value: string }[],
    context: Record<string, unknown> = {},
  ) {
    super(
      CHAIN_ERROR_CODES.CROSS_CHECK_MISMATCH,
      `§99 cross-check failed for ${method}: ${observations
        .map((observation) => `${observation.endpoint}=${observation.value.slice(0, 74)}`)
        .join(' vs ')}`,
      { method, observations, ...context },
    );
    this.name = 'CrossCheckError';
    this.method = method;
    this.observations = observations;
  }
}

export class ChainIdMismatchError extends ChainError {
  constructor(expected: number, actual: number, endpoint: string) {
    super(
      CHAIN_ERROR_CODES.CHAIN_ID_MISMATCH,
      `RPC endpoint ${endpoint} reports chainId ${actual}, expected ${expected}`,
      { expected, actual, endpoint },
    );
    this.name = 'ChainIdMismatchError';
  }
}

/** §95: a write was refused because at least one pre-flight check failed. */
export class TxGuardError extends ChainError {
  readonly failures: readonly string[];

  constructor(failures: readonly string[], context: Record<string, unknown> = {}) {
    super(
      CHAIN_ERROR_CODES.TX_GUARD_FAILED,
      `§95 pre-flight checks refused the transaction: ${failures.join('; ')}`,
      { failures, ...context },
    );
    this.name = 'TxGuardError';
    this.failures = failures;
  }
}

/**
 * §98 `UNKNOWN`. Deliberately distinct from a generic error so no caller can mistakenly treat it as
 * retryable: an unknown transaction may already be mining, so re-sending would double-spend the
 * intended swap/liquidity action.
 */
export class TxStateUnknownError extends ChainError {
  readonly txHash: string;
  readonly reason: string;

  constructor(txHash: string, reason: string, context: Record<string, unknown> = {}) {
    super(
      CHAIN_ERROR_CODES.TX_STATE_UNKNOWN,
      `transaction ${txHash} is UNKNOWN (${reason}); re-query the chain, never auto-retry (§96)`,
      { txHash, reason, ...context },
    );
    this.name = 'TxStateUnknownError';
    this.txHash = txHash;
    this.reason = reason;
  }
}
