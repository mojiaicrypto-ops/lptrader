# D2 — Test Report

```yaml
test:
  task: D2
  environment:
    node: v24.8.0
    ts_runner: node --experimental-strip-types
    chain: BNB Chain (chainId 56) — read-only runs against public RPC (bsc-dataseed, publicnode)
    signer: NONE (no private key present; every run below is read-only or dry-run)
    network: live HTTP (Binance, GeckoTerminal, DexPaprika) + live BSC RPC
  commands:
    - command: npm run typecheck
      result: passed
      exit_code: 0
      evidence: "tsc --noEmit, 0 errors across 49 src / 25 test / 6 script files"
    - command: npm test
      result: passed
      exit_code: 0
      evidence: "24 test files / 701 tests, all green"
    - command: npm run smoke:read
      result: passed
      evidence: "verdict: all required reads succeeded. 8 bStocks probed; local toUIAmount matches the contract for every sample."
    - command: npm run smoke:quote
      result: passed
      evidence: "1000 USDT -> 1.353115 QQQB, priceImpact 0.012314%, amountOutMinimumRaw floored, TTL 30s"
    - command: npm run dry-run:build -- 7000
      result: passed
      exit_code: 0
      evidence: |
        Full decision chain on live data, nothing signed or sent:
          §16 passed:  2 pools (QQQB/USDT @ PancakeSwap 0xe531…, QQQB/USDC @ Uniswap 0xfc4e…)
          LP capital:  4900.00 (7000 x 0.70)
          value sum:   4900.00 (exact)
          optimal vs fixed 50/50: 4.383%  (proves §35 is not a fixed split)
          ticks aligned (§34): true
          priceImpact: adapter vs independent recomputation -> exact
          §40 gate:    ok
          funding:     within 1% (mid-price solve vs fee-paying swap)
          atomicity:   single transaction (swap + mint combined)
    - command: npm run smoke:scan
      result: passed
      exit_code: 0
      evidence: "see docs/research/evidence-smoke-scan-20260929-t6.txt — scan complete=true, 0 blockers, proven-absent vs unverifiable distinguished"
  not_covered:
    - area: Real signed transaction (first live BUILD_POSITION)
      reason: |
        Requires a funded strategy wallet and a decrypted key, and an approved BUILD_POSITION per D2.
        Deliberately not exercised: the whole point of the approval gate is that no transaction is sent
        without a human answer, so a test that sent one would be testing the absence of the gate.
      disposition: accepted
    - area: Live LP position read (positions()/tokensOwed) against a real position
      reason: No position exists yet; the code path is covered by unit tests and the dry-run covers valuation math. Needs `STRATEGY_WALLET_ADDRESS` + `LP_POSITION_TOKEN_ID` once a position is opened.
      disposition: pending
    - area: Real Telegram Bot API interaction
      reason: Needs the user's bot token, chat id and user id. All gate behaviour is covered offline with an injected transport (55 tests), including fail-closed on 5xx/timeout/expiry/non-whitelisted user.
      disposition: pending
    - area: §101 backtest / §102 multi-week paper trading
      reason: Out of Iteration 1 scope by user decision (D1). The dry-run covers the §102 "decide without sending" core.
      disposition: accepted
  result: passed
```

## Independent verification (the reviewer's own probes, re-run after the fixes)

The four blocking findings from the review were re-checked with the **reviewers' original probe scripts**, not with new tests written to pass:

| finding | probe | before | after |
|---|---|---|---|
| F1 forged guard → non-whitelisted target | `/tmp/omp-rev/guard-bypass.test.ts` | guard accepted, send proceeded | `ADDRESS_NOT_WHITELISTED`, **0 sends** |
| F2 atomic build record | `/tmp/mut2/.../probe2.test.ts` | primary row `CREATED`, no hash, unresolvable | primary `SUBMITTED` w/ hash → `CONFIRMED` resolvable |
| F3 retry after REVERTED | same | `adapter_failed` at `markSubmitted` | attempts `[1,2]`, attempt 2 `SUBMITTED` with new hash |
| F4 valuation → §66 | `/tmp/probe6.ts` | `complete=false`, `totalNAV=0`, `breached=true` | `complete=true`, `totalNAV=3001.11`, no phantom breach |

## Bugs the test pass itself surfaced (beyond the review)

1. **§99 cross-check false-failed every live read** (KI-19). Two endpoints returned `sqrtPriceX96` differing in the 9th significant digit with an identical `tick` — one block of price movement — and exact-equality comparison rejected it. Fixed by pinning one block height per cross-check; without the pin, *every* critical read (`slot0`, balances) was liable to fail on live data, i.e. the bot could not have read the chain at all.

2. **Pancake SmartRouter was missing from the write-target whitelist.** The new target check refused the §42 atomic build outright, revealing that the contract the atomic path targets was never listed. Fixed (address cross-checked against `SMART_ROUTER_ADDRESSES[56]`).

3. **`poolAgeDays`/impact observations differ between runs.** The same Uniswap QQQB/USDC pool failed §16 on the `$3500 → 0.66% > 0.5%` impact gate in one run and passed at `0.04%` in another. That is expected for a live, mutable metric, and it is why §16 is re-evaluated every scan rather than cached as a pool property. Recorded so the difference is not mistaken for a defect.

## Remaining risk carried into Settlement

- Nothing in the changed surface is unexercised except the four `not_covered` items above, three of which are user-gated by design.
- KI-15 (NAV `realizedFees` reading) is an open **product** question, not a test gap: the implementation chooses the conservative reading and needs the user's confirmation.
