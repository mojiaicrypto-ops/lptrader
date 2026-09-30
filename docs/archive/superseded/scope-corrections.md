# 产品基线范围内的事实修正（Iteration 1）

**性质**：对 `docs/product/stock-lp-auto-strategy-v1.md` 的**不改语义**的读法澄清。
**原则**：只澄清「基线文本与现实不一致」的读法，不改变任何产品行为、范围或验收标准。改变范围需用户显式确认。

| # | 基线文本 | 现实（实测，2026-09-29） | 澄清（不改语义） |
|---|---|---|---|
| C1 | §14「扫描 Whitelist Stock Token × Whitelist Stablecoin × Whitelist DEX」；§109 Phase 3「只允许 QQQB / USDC」 | **不存在 PancakeSwap V3 的 QQQB/USDC 池**。实际存在：QQQB/USDC @ **Uniswap V3 (BSC)** `0xfc4e7724…`（0.3%，TVL $1.77M）；QQQB/USDT @ PancakeSwap V3 `0xe531fcb1…`（0.01%，TVL $0.62M） | §12 的 DEX 白名单已含 Uniswap V3 与 PancakeSwap V3（且唯一标识为 §13 `chainId+dex+poolAddress`），§110 已含「USDC 或 USDT」。故候选池由 **Scanner 从白名单安全交叉集自动发现**，不写死单一组合；「只允许 QQQB」约束的是**股票代币脚**。以上池均在范围内。 |
| C2 | §86 Token Config 用 `symbol` + `contract: "OFFICIAL_ADDRESS"` | 实测同链存在同 symbol 异物（`QQQx`/`QQQon`/冒充地址）+ 链上 ticker 大小写不一 | §8 已规定以 Contract Address 为准。实现层 **Registry 以地址为主键**；`symbol` 仅作白名单内的显示别名，禁止按 symbol 解析或多义匹配。 |
| C3 | §33「CORE 股票代币默认 Range：Lower = 当前价 × 0.85 / Upper = × 1.16」；§49 `RangeProgress` | `RangeProgress` 定义 `(Current − Lower)/(Upper − Lower)` 在区间是 **右偏**（下限侧 0%、上限侧 100%），与「上界 +16% / 下界 −15%」的非对称区间不一致 | **已裁定（2026-09-29）**：按 §49 **字面**取 `RangeProgress`（`< 0.20` 靠近下界、`> 0.80` 靠近上界），**仅用于 `BOUNDARY_WATCH` 告警，不参与任何交易决策**。对称比例口径不实现。 |
| C4 | §75 `Position` 记录 `initialToken0/initialToken1`、`liquidity` 等 | bStocks 为 **BEP-677 Scaled UI Amount**：`balanceOf()` 不随分红/拆股变化，只有 `uiMultiplier()` 变 | 所有余额/份额/金额一律经 UI 换算（`balanceOfUI()`/`toUIAmount()`）；`uiMultiplier()` **运行期读取**，禁止硬编码 `1e18`。这属于 §5「Portfolio NAV 必须正确」的实现正确性，不改变产品语义。 |
| C5 | §90 Weekly Report、§79 Dashboard 要求 `IL` / `Fee/IL Ratio`（§7） | — | 首期必须内置 **Benchmark 组合（建仓时同比例的 Buy & Hold）**，IL 与 `FeeILRatio` 均由 Benchmark 差分得出（§6 + §7）。无 Benchmark 则 §7 指标不可算 → Benchmark 不是可选项。 |
