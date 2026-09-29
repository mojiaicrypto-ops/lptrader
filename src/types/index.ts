/**
 * Shared contract layer — FROZEN INTERFACES for T4–T12.
 *
 * ## Interface conventions (binding for every downstream task)
 *
 * 1. **Amounts are raw `bigint`, prices/NAV are `number`.** Any token amount that could ever be
 *    signed is `bigint` in RAW base units (`TokenAmount.raw`); UI-scaled values (`TokenAmount.ui`)
 *    exist only for valuation/reporting. USD values and ratios are doubles and MUST NOT be
 *    converted back into a signed token amount. BSC USDC/USDT are **18** decimals, not 6.
 *    bStocks are BEP-677 scaled — always read `uiMultiplier()` at runtime, never assume `1e18`.
 *
 * 2. **Identity is `(chainId, lowercased address)`; symbols are display-only.** Use
 *    `TokenRegistry.getByAddress` / `requireByAddress`. There is no symbol→address API by design.
 *    Pool identity is `chainId + dex + poolAddress` (`PoolRef.poolId`), never token pair + fee.
 *
 * 3. **Unknown ⇒ nothing happens (fail closed).** Every external figure travels as `Sourced<T>`
 *    with `source` + `stale`; `DataSource.UNAVAILABLE` and `TxState.UNKNOWN` must stop the pipeline
 *    (no retry, no guess). `NO_NEW_CAPITAL_STATES` / `READ_ONLY_STATES` list the states in which
 *    no transaction may be sent. `TxGuardChecks.ok === false` means the adapter must refuse to send.
 */

export * from './primitives.ts';
export * from './token.ts';
export * from './market.ts';
export * from './portfolio.ts';
export * from './adapters.ts';
export * from './state.ts';
export * from './notifier.ts';
export * from './registry.ts';
export * from './config.ts';
