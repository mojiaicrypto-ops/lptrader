# T5 Test Report (2026-10-02)

## Unit / integration suite
```
npx tsc --noEmit      → 0 error
npx vitest run        → Test Files 40 passed (40) / Tests 860 passed (860)
```
- Deleted: all §42 atomic-semantics tests (obsolete behavior per D3.7 — not re-pinned).
- Rewritten: §98 attempt-numbering tests onto the uniform two-step shape; mint/swap state
  assertions SUBMITTED → CONFIRMED (the adapter now confirms before returning, §5.3.5).
- mockNode: receipts may carry logs (a mint's IncreaseLiquidity); blockheight helper aligned
  with the harness receipts (the mismatch spun the confirm wait to its 30s test timeout).

## Live (real-money) verification — the acceptance criterion
| 项 | PancakeSwap V3 | Uniswap V3 |
|---|---|---|
| pool | QQQB/USDT 0.01% 0xe531fcb1… | AAPLB/USDT 0.05% 0x36c0fc31… |
| swap tx | 0x5188988a…81b7da | 0x40982343…bdfc5 |
| mint tx | 0x2dc35be8…4385f | 0x7e8ceda8…f4e98 |
| tokenId | 7604786 | 2808516 |
| final USDT | 5.861389 | 1.759873 |
| Price slippage check | 无 | 无 |
Gas after both runs: BNB 0.00977.

## Not covered
- removeLiquidity/collectFees 的确认与换 U（T6 范围，断言保持 SUBMITTED）。
- 换池闭环（T10+）。撤池后重建仓未实盘。
