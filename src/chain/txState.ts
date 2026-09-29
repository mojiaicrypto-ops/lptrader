/**
 * §98 transaction state machine + §95 pre-flight guard.
 *
 * The two invariants this module exists to enforce:
 *
 * 1. **`UNKNOWN` is terminal for automated control flow.** `UNKNOWN` means "we could not determine
 *    whether the transaction is on chain". It may already be mining; re-sending the same intent
 *    would double the position/swap. So there is no automatic resend anywhere in this file, and
 *    `UNKNOWN` can only be left through an explicit on-chain re-query (§96 Fail Closed).
 * 2. **No transaction is sent without a complete §95 check set.** The guard fields are evaluated by
 *    the executor and passed in; `assertTxGuard` re-derives `ok`, so a caller that hand-builds a
 *    `TxGuardChecks` with `ok: true` and a failed sub-check is refused rather than trusted.
 */
import type { Address, Hex } from '../types/primitives.ts';
import {
  TX_STATES,
  type TransactionInfo,
  type TxGuardChecks,
  type TxState,
} from '../types/adapters.ts';
import { ChainError, CHAIN_ERROR_CODES, TxGuardError } from './errors.ts';

/** §98 transitions. `UNKNOWN` may resolve to any mined state; nothing may leave it automatically. */
export const TX_TRANSITIONS: Readonly<Record<TxState, readonly TxState[]>> = {
  [TX_STATES.CREATED]: [TX_STATES.SUBMITTED, TX_STATES.FAILED, TX_STATES.UNKNOWN],
  [TX_STATES.SUBMITTED]: [
    TX_STATES.CONFIRMED,
    TX_STATES.FAILED,
    TX_STATES.REVERTED,
    TX_STATES.UNKNOWN,
  ],
  // CONFIRMED and REVERTED are final: a mined transaction's outcome cannot change.
  [TX_STATES.CONFIRMED]: [TX_STATES.CONFIRMED],
  [TX_STATES.REVERTED]: [TX_STATES.REVERTED],
  /** §98: a dropped/replaced/not-yet-propagated transaction. Only an explicit re-query may resolve it. */
  [TX_STATES.FAILED]: [TX_STATES.UNKNOWN],
  [TX_STATES.UNKNOWN]: [
    TX_STATES.CONFIRMED,
    TX_STATES.REVERTED,
    TX_STATES.FAILED,
    // Re-querying may legitimately keep returning UNKNOWN (mempool still silent).
    TX_STATES.UNKNOWN,
  ],
};

/** True when `next` is a legal §98 successor of `current`. */
export function canTransition(current: TxState, next: TxState): boolean {
  return (TX_TRANSITIONS[current] ?? []).includes(next);
}

/**
 * Recorded outcome of one send attempt. `attempts` is the number of times a transaction was
 * broadcast for this intent; it may only ever be `1` for an automated flow, and any higher value
 * means a human explicitly re-sent after the chain confirmed the original had not landed.
 */
export interface TxLifecycle {
  readonly state: TxState;
  readonly hash: Hex | null;
  readonly attempts: number;
  readonly unknownReason: string | null;
}

export function initialTxLifecycle(): TxLifecycle {
  return { state: TX_STATES.CREATED, hash: null, attempts: 0, unknownReason: null };
}

/**
 * §98 `UNKNOWN` decision: an automated caller must re-query the chain (`getTransaction` on the
 * recorded hash) and must NOT broadcast again. This function is the single place that decides —
 * it returns a decision instead of throwing so the caller can log and alert.
 */
export interface UnknownResolution {
  readonly hash: Hex;
  /** Always false for automated flows; the field exists so callers cannot "forget" the rule. */
  readonly mayResend: false;
  readonly requiredAction: 'requery-on-chain' | 'operator-review';
  readonly reason: string;
}

export function resolveUnknown(lifecycle: TxLifecycle, requeryFailed: boolean): UnknownResolution {
  if (lifecycle.hash === null) {
    // A transaction that never produced a hash is indistinguishable from one that was never sent;
    // the only safe move is to stop and have an operator look at the node/mempool.
    return {
      hash: '0x',
      mayResend: false,
      requiredAction: 'operator-review',
      reason: `no transaction hash was recorded (${lifecycle.unknownReason ?? 'unknown'})`,
    };
  }
  return {
    hash: lifecycle.hash,
    mayResend: false,
    requiredAction: requeryFailed ? 'operator-review' : 'requery-on-chain',
    reason:
      lifecycle.unknownReason ??
      'transaction state could not be determined; it may already be mining',
  };
}

/**
 * §95 pre-flight verification.
 *
 * `assertTxGuard` refuses to send unless every check passed. It deliberately re-computes `ok` from
 * the sub-checks plus the explicit `failures` list, so a malformed guard object (any `false`
 * sub-check with `ok: true`) is caught here rather than on chain.
 */
export function assertTxGuard(
  guard: TxGuardChecks,
  context: { readonly to: Address } | undefined = undefined,
): void {
  const failedChecks = GUARD_CHECK_KEYS.filter((key) => guard[key] !== true).map(
    (key) => GUARD_CHECK_LABELS[key],
  );
  const failures = [...new Set([...failedChecks, ...guard.failures])];
  if (failures.length > 0 || guard.ok !== true) {
    throw new TxGuardError(failures.length > 0 ? failures : ['guard.ok is false'], {
      ...(context ?? {}),
    });
  }
}

/** The §95 check keys, in fixed order. */
export const GUARD_CHECK_KEYS = [
  'chainIdOk',
  'toWhitelisted',
  'tokenInWhitelisted',
  'tokenOutWhitelisted',
  'functionSelectorOk',
  'amountWithinLimit',
  'slippageWithinLimit',
  'deadlineOk',
  'gasLimitSet',
  'allowanceNotUnlimited',
] as const satisfies readonly (keyof TxGuardChecks)[];

/** Human-readable refusal reason per check, used in `failures` and in the thrown error. */
export const GUARD_CHECK_LABELS: Readonly<Record<(typeof GUARD_CHECK_KEYS)[number], string>> = {
  chainIdOk: 'chainId does not match the whitelisted chain (§11)',
  toWhitelisted: 'target contract is not whitelisted (§8/§12)',
  tokenInWhitelisted: 'tokenIn is not whitelisted (§8)',
  tokenOutWhitelisted: 'tokenOut is not whitelisted (§8)',
  functionSelectorOk: 'function selector is not one of the reviewed selectors',
  amountWithinLimit: 'amount exceeds the configured limit',
  slippageWithinLimit: 'slippage exceeds max_slippage (§40)',
  deadlineOk: 'deadline is missing or already expired (§42)',
  gasLimitSet: 'gas limit was not set',
  allowanceNotUnlimited: 'allowance is unlimited — prohibited (§93)',
};

/** Build a `TxGuardChecks` from the individual booleans, deriving `failures` and `ok`. */
export function buildTxGuard(checks: Omit<TxGuardChecks, 'ok' | 'failures'>): TxGuardChecks {
  const failures = GUARD_CHECK_KEYS.filter((key) => checks[key] !== true).map(
    (key) => GUARD_CHECK_LABELS[key],
  );
  return { ...checks, ok: failures.length === 0, failures };
}

/**
 * A guard that reports `false` for everything. Used as the initial value before an executor fills
 * in the real checks: an unfilled guard must never accidentally be `ok`.
 */
export function emptyTxGuard(): TxGuardChecks {
  return buildTxGuard({
    chainIdOk: false,
    toWhitelisted: false,
    tokenInWhitelisted: false,
    tokenOutWhitelisted: false,
    functionSelectorOk: false,
    amountWithinLimit: false,
    slippageWithinLimit: false,
    deadlineOk: false,
    gasLimitSet: false,
    allowanceNotUnlimited: false,
  });
}

/** Block a `data` payload's function selector (`0x` + 4 bytes). */
export function selectorOf(data: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{8}/u.test(data)) {
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `calldata ${data.slice(0, 12)} does not start with a 4-byte function selector`,
      { data: data.slice(0, 12) },
    );
  }
  return data.slice(0, 10).toLowerCase() as Hex;
}

/**
 * Interpret a node's transaction payload into a §98 state.
 *
 * `null` input (the node has never heard of the hash) is the **`UNKNOWN`** case, not `FAILED`:
 * "not found" may mean the transaction was dropped *or* that it has not propagated to this node
 * yet. Concluding `FAILED` would license a re-send and risk a double execution, so the state is
 * left undetermined.
 */
export function interpretTransaction(
  hash: Hex,
  node: {
    readonly blockNumber: bigint | null;
    readonly from: Address;
    readonly to: Address | null;
    readonly value: bigint;
    readonly gasUsed?: bigint;
    readonly gasPrice?: bigint;
    readonly effectiveGasPrice?: bigint;
    readonly status?: 'success' | 'reverted';
  } | null,
): TransactionInfo {
  if (node === null) {
    return {
      hash,
      state: TX_STATES.UNKNOWN,
      blockNumber: null,
      from: '0x',
      to: null,
      value: 0n,
      unknownReason:
        'the RPC node does not know this transaction hash; it may have been dropped or may not have propagated yet — re-query later, never auto-retry (§96)',
    };
  }

  const blockNumber = node.blockNumber;
  let state: TxState;
  if (blockNumber === null) {
    state = TX_STATES.SUBMITTED;
  } else if (node.status === 'reverted') {
    state = TX_STATES.REVERTED;
  } else if (node.status === 'success') {
    state = TX_STATES.CONFIRMED;
  } else {
    // Mined but the node did not report a status: viem only omits `status` for pre-Byzantium
    // blocks, so this is an anomaly rather than an expected case.
    state = TX_STATES.UNKNOWN;
  }

  const gasUsed = node.gasUsed;
  const effectiveGasPriceWei = node.effectiveGasPrice ?? node.gasPrice;

  return {
    hash,
    state,
    blockNumber,
    from: node.from,
    to: node.to,
    value: node.value,
    ...(gasUsed === undefined ? {} : { gasUsed }),
    ...(effectiveGasPriceWei === undefined ? {} : { effectiveGasPriceWei }),
    ...(state === TX_STATES.UNKNOWN
      ? {
          unknownReason: `receipt for block ${blockNumber} carries no status field; state is undetermined`,
        }
      : {}),
  };
}
