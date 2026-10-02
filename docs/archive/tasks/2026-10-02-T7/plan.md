# T7 全量计划 — 持仓估值 + APR（§4.2.1）

**状态**：用户预授权（会话 2026-10-02："照开发 skills 走完，实盘验证"）。

## 目标与验收

监控读法达到 §4.2.1 口径：

```text
① 读 LP 实际腿值（当前 tick/价格 换算）+ 未领 fee（static-call collect 读数，非记账值）
② 折 U 并分项：仓位价值 / fee 价值（单独可见）/ 仓位权益合计
③ APR = 年化的 (当前权益 − 入场权益) / 入场权益，分母 = 建仓前的 U（entryEquityUsd）
④ /position 与 /nav 均可见
```

验收：实盘 建仓 → 读估值 → 撤池，全链真金（Pancake QQQB/USDT，唯一过 §16 的池）。

## 现状核对（差距仅在 APR + 展示）

| §4.2.1 项 | 现状 |
|---|---|
| LP 腿值 + fee 折 U | ✅ `portfolioMonitor.lpPositionValue` + `unclaimedFeeValue`（记账值 tokensOwed） |
| fee 单独可见 | ⚠️ /position 有"未领手续费"，但没有 LP 价值/合计/APR |
| APR 年化 | ❌ 无任何年化代码 |
| 分母 = 建仓前 U | ✅（依赖 §5.3.1：entryEquityUsd 记录于建仓时 = 纯 U 钱包 NAV） |

## 实现

1. `src/strategy/returns.ts`：+ `computeAnnualizedApr(returnRatio, openedAt, now)` —— 简单年化
   （总收益率 ÷ 持有年数）；持有 <1h 返回 null（避免小时级外推爆炸）。fee 折 U 单独列出。
2. `src/runtime/queryCache.ts`：`PositionView` += `lpValueUsd / totalEquityUsd / aprRatio(aprIndicative) `。
3. `src/runtime.ts`：`positionViewFrom` 接收本拍估值 + APR；portfolioHealth 节拍传入。
4. `src/runtime/queryHandlers.ts`：`/position` 加 仓位价值/权益合计/APR 行；`/nav` 收益块加 APR 行。
5. `scripts/live-build.ts`：`--value <tokenId> --entry <usd>` 模式 —— 链上读数输出 §4.2.1 表
   （fee 用 NPM `collect` 的 eth_call 读数，比记账值准）。
6. 测试：APR 数学（含 1h 下界、负 APR）、/position 渲染行。

## 风险

- fee 的 eth_call 读数对 payable 函数依赖 viem `readContract` 正确走 eth_call（value 0）。
- 短持有期 APR 外推无意义 → 显式 indicative 标记，不写进任何交易判定（收益判定仍用 §7D Net APR，
  由 scanner 独立计算，与本展示正交）。
