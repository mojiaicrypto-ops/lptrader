# Tokenized Stock LP Auto Strategy — 股票代币集中流动性自动管理系统

**Version:** V1.0
**Strategy Type:** Concentrated Liquidity / Tokenized Stock LP
**Primary Chain:** BNB Chain
**Initial DEX:** Uniswap V3 / PancakeSwap V3
**Initial Capital Example:** 10,000 USDC
**Primary Objective:** 在严格控制资产风险、Token 脱锚风险、无常损失和换池成本的前提下，自动选择并管理股票代币 / Stablecoin LP。

> 来源：用户提供的 V1.0 策略规格书（2026-09-29 落入本仓库，作为 canonical product baseline）。
> 本文件是产品事实来源；对话历史仅为工作材料。

---

## 1. 产品目标

本系统不是一个追逐最高 APR 的 Yield Farming Bot。

系统定位为：

> **一个以风险控制为第一优先级的股票代币 LP 自动资产管理系统。**

系统需要自动完成：

1. 账户资产监控
2. 股票代币池扫描
3. 池子风险过滤
4. 池子收益评估
5. 最优池选择
6. LP 建仓比例计算
7. Stablecoin 自动兑换目标股票代币
8. Concentrated Liquidity Position 建仓
9. LP 收益持续监控
10. Token / NAV 脱锚监控
11. LP 区间监控
12. 收益下降后的换池判断
13. Position 自动退出
14. 自动寻找替代池
15. 全局风险控制
16. 收益统计与 Benchmark

V1 不做：

- 高频交易
- 股价预测
- AI 方向预测
- 杠杆
- 借贷
- Delta Neutral
- Futures Hedge
- 高频 Rebalance
- 自动追涨
- 自动补仓
- 无限制 Compound
- 未授权 Token 自动发现

---

## 2. 核心设计原则

### 2.1 Risk First

优先级：

```text
资金安全
>
Token 正常
>
Liquidity 正常
>
收益稳定
>
APR 高低
```

绝不因为高 APR 忽略：Token 风险、流动性风险、脱锚风险、Smart Contract 风险、Slippage、Swap Cost、Rebalance Cost。

### 2.2 不追求最高 APR

策略目标不是：

```text
MAX(APR)
```

而是：

```text
MAX( Expected Net Yield × Risk Adjusted Score )
```

其中：

```text
Expected Net Yield
=
LP Fees
+ Incentives
- Impermanent Loss
- Swap Costs
- Slippage
- Gas
- Switching Costs
```

---

## 3. 初始资金模型

```text
Initial Capital = 10,000 USDC
```

默认资产配置：

```text
70% LP Capital
30% Reserve Capital
```

即：

```text
LP Max Allocation = 7,000 USDC Equivalent
Reserve           = 3,000 USDC
```

```yaml
portfolio:
  max_lp_ratio: 0.70
  reserve_ratio: 0.30
```

---

## 4. Reserve 资金定义

30% Reserve 不属于闲置资金。其职责：

- 防止所有资金进入风险资产
- 应对异常退出
- 下一轮重新建仓
- 支付 Gas
- Swap 缓冲
- Position 重建
- 保证资产流动性

默认禁止因为 APR 上升而自动投入 Reserve。

---

## 5. Portfolio NAV

系统不能只监控钱包余额。必须计算：

```text
TotalNAV = Wallet Assets + LP Position Value + Unclaimed Fees + Realized Fees
```

```typescript
PortfolioSnapshot {
    timestamp
    walletStablecoinValue
    walletStockTokenValue
    lpToken0Amount
    lpToken1Amount
    lpPositionValue
    unclaimedFeeToken0
    unclaimedFeeToken1
    unclaimedFeeValue
    realizedFees
    gasCost
    swapCost
    slippageCost
    totalNAV
    initialNAV
    peakNAV
    benchmarkNAV
    lpAllocationRatio
    reserveRatio
}
```

---

## 6. Benchmark

必须建立 Benchmark。否则无法判断：LP 到底是真赚钱，还是只是股票本身上涨。

默认 Benchmark：建仓时相同 Token 比例的 Buy & Hold。

例如建 LP 时 `45% QQQB / 55% USDC`，Benchmark 即假设 `45% QQQB / 55% USDC` 持有不动。

```text
LP Alpha = Actual Portfolio Value - Benchmark Value
```

---

## 7. 核心健康指标

### 7.1 Fee / IL Ratio

```text
FeeILRatio = Accumulated Fees / Impermanent Loss
```

```text
> 2     Healthy
1 ~ 2   Acceptable
< 1     Warning
```

若连续多个周期 `FeeILRatio < 1`，则策略质量下降。

---

## 8. Token 白名单

V1 不允许动态购买未知股票 Token。必须使用 Contract Address Whitelist。

不能依据 `Symbol == "QQQB"` 判断 Token；必须 `ContractAddress == ApprovedAddress`。

---

## 9. Token 风险等级

**CORE**（优先使用）：`QQQB` `MSFTB` `AAPLB` `AMZNB` `METAB`

**HIGH_VOL**（默认允许监控，V1 不自动建仓）：`NVDAB` `TSLAB` `PLTRB`

**BLOCKED**（禁止自动参与）：Leveraged ETF、Inverse ETF、Highly Leveraged Equity Token、Unknown Token、Unverified Stock Token

---

## 10. Stablecoin 白名单

V1：`USDC` `USDT`，默认偏好 `USDC > USDT`。

未来可增加 `FDUSD` `USDe` `USD1`，但必须单独经过风险审批。

---

## 11. Chain Whitelist

V1：BNB Chain。

未来支持：X Layer、Ethereum、Base、RH Chain、Other EVM Chains。Chain 必须 Adapter 化。

---

## 12. DEX Whitelist

V1：`Uniswap V3` `PancakeSwap V3`。

未来：Uniswap V4、其他 CLMM。

禁止自动进入未知 DEX。

---

## 13. Pool 唯一标识

```text
chainId + dex + poolAddress
```

不能只通过 `Token0 + Token1 + FeeTier` 识别。

---

## 14. Pool Scanner

默认每 1 小时扫描一次：

```yaml
scanner:
  interval_minutes: 60
```

扫描对象：`Whitelist Stock Token × Whitelist Stablecoin × Whitelist DEX`

---

## 15. Pool 数据

```typescript
PoolSnapshot {
    timestamp
    chainId
    dex
    poolAddress
    token0
    token1
    feeTier
    tvlUSD
    volume24h
    volume7d
    fees24h
    fees7d
    poolAge
    currentPrice
    currentTick
    activeLiquidity
    stockReferencePrice
    tokenNAVDeviation
    stockVolatility7d
    stockVolatility30d
    swapImpact1000USD
    swapImpact3500USD
    swapImpact5000USD
    estimatedAPR1d
    estimatedAPR7d
    estimatedAPR30d
}
```

---

## 16. Pool 硬性过滤

任一条件不满足：直接淘汰，不进入 Pool Ranking。

```yaml
pool_filter:
  min_tvl_usd: 500000
  min_avg_daily_volume_7d: 250000
  min_pool_age_days: 7
  max_nav_deviation: 0.01
  max_swap_price_impact: 0.005
```

```text
TVL >= $500,000
7D Avg Daily Volume >= $250,000
Pool Age >= 7 Days
Token/NAV Deviation < 1%
$3500 Swap Price Impact < 0.5%
```

---

## 17. APR 禁止直接使用前端数字

系统禁止直接使用 Frontend APR / Frontend APY 作为决策依据。必须独立计算。

---

## 18. Fee APR

基础版：

```text
FeeAPR7D = Fees7D / AverageTVL7D × 365 / 7
```

更高级版本应计算 `Expected Position Fee APR`，即基于用户 Range、当前 Active Liquidity、Range 内其他流动性、当前交易量计算该 Position 实际预期 Fee。

---

## 19. Net APR

系统真正比较 `ExpectedNetAPR`，而非 Gross APR：

```text
ExpectedNetAPR
=
FeeAPR
+ Realistic Incentive APR
- Expected IL Cost
- Expected Swap Cost
- Expected Gas Cost
- Expected Rebalance Cost
```

---

## 20. Incentive Haircut

存在 Token Rewards / Points / Airdrop / Incentive Token 时，不得按页面价值 100% 计入收益。

```yaml
incentive:
  haircut: 0.50
```

若 Incentive APR = 20%，策略评估只计算 10%。

---

## 21. Pool Ranking

```text
PoolScore
=
YieldScore × 35%
+ LiquidityScore × 25%
+ VolumeStabilityScore × 15%
+ AssetStabilityScore × 15%
+ PegQualityScore × 10%
```

---

## 22. Yield Score

考虑 7D / 30D Expected Net APR。不能单独使用 1D APR。

---

## 23. Liquidity Score

考虑 TVL、Active Liquidity、Swap Price Impact。

---

## 24. Volume Stability Score

不能因为某一天突然出现 `$10M Volume` 就判断池子优秀。需要衡量 Volume7D / Volume30D Stability，例如标准差、变异系数、最大日 / 中位数。

---

## 25. Asset Stability Score

指数类（`QQQB`）得分通常高于高 Beta 股票（`TSLAB` `NVDAB`）。

---

## 26. Peg Quality Score

衡量 Stock Token Onchain Price vs Underlying Reference NAV。

---

## 27. 默认目标收益

```yaml
yield:
  target_net_apr: 0.15
  warning_net_apr: 0.12
```

目标：`Net APR >= 15%`。

---

## 28. 收益下降规则

禁止 `APR < 15% 立即换池`。默认：

```text
7D Expected Net APR < 12%，持续 72 Hours
```

才进入 `SEARCH_REPLACEMENT`。

```yaml
yield:
  underperformance_threshold: 0.12
  underperformance_duration_hours: 72
```

---

## 29. 换池原则

```text
New Pool Expected Net APR >= Current Pool Expected Net APR + 8 Percentage Points
```

例：Current = 12%，New = 16% → 不换；Current = 12%，New = 24% → 进入进一步评估。

---

## 30. Switching Cost

```text
Remove Liquidity Cost
+ Collect Fee Cost
+ Token A → Stablecoin Swap Cost
+ Stablecoin → Token B Swap Cost
+ Add Liquidity Cost
+ Gas
+ Slippage
+ Realized IL
= SwitchingCostUSD
```

---

## 31. Break Even Days

```text
AdditionalDailyYield = (NewPoolAPR - CurrentPoolAPR) × Capital / 365
BreakEvenDays        = SwitchingCostUSD / AdditionalDailyYield
```

默认要求 `BreakEvenDays <= 14`，否则不换池。

---

## 32. Switch Cooldown

成功换池后 7 Days 内禁止因为 APR 原因再次换池。

```yaml
switch:
  cooldown_days: 7
```

不受 Cooldown 限制：Token 脱锚、Smart Contract 风险、Issuer 风险、TVL 崩溃、Liquidity 消失、Redemption 问题、Emergency Risk Event。

---

## 33. LP Position Range

CORE 股票代币默认 Range：

```text
Lower = Current Price × 0.85
Upper = Current Price × 1.16
```

即约 -15% / +16%。未来可根据历史波动率动态调整。

---

## 34. Tick Alignment

实际 Range 必须按照 `tickSpacing` 对齐。禁止使用未对齐 tick。

---

## 35. 不采用固定 50/50 Swap

这是核心设计要求。错误方案：

```text
7000 USDC → 3500 → QQQB，3500 USDC，Add Liquidity
```

该方案只在特定价格位置下接近正确。

---

## 36. 正确的建仓过程

系统应该由 `Current Price + Lower Price + Upper Price + Total Capital` 首先计算 `Optimal Token0 Amount` / `Optimal Token1 Amount`，然后再决定 Swap 数量。

---

## 37. Concentrated Liquidity 数学

```text
Pa = Lower Price, P = Current Price, Pb = Upper Price, Pa < P < Pb

amount0 = L × ( 1/sqrt(P)  - 1/sqrt(Pb) )
amount1 = L × ( sqrt(P) - sqrt(Pa) )
```

程序应根据 Total USD Capital 反推 `L` 以及 `amount0` / `amount1`。

---

## 38. Optimal Swap

例如 `LP Capital = $7000`，计算结果 `QQQB Required Value = $3180`，`USDC Required = $3820`，

则 Swap `$3180 USDC → QQQB` 然后 Add Liquidity，而不是固定 `$3500`。

---

## 39. Swap 建仓流程

```text
Read Latest Pool Price
↓
Calculate Range
↓
Calculate Optimal Token Ratio
↓
Get Swap Quote
↓
Check Price Impact
↓
Check Slippage
↓
Refresh Price
↓
Recalculate Ratio
↓
Validate Difference
↓
Execute Swap
↓
Verify Balance
↓
Add Liquidity
↓
Verify Position
```

---

## 40. Swap 风控

```yaml
swap:
  max_slippage: 0.003
  max_price_impact: 0.005
```

```text
Max Slippage = 0.3%
Max Price Impact = 0.5%
```

`Price Impact > 0.5%` → 取消本轮建仓。
`Price Impact > 1%` → Pool 标记为 `Liquidity Risk`。

---

## 41. Quote 过期

Swap Quote 应有 TTL，例如 30 秒。超过后必须重新 Quote。

---

## 42. 建仓原子性

理想情况下 Swap + Add Liquidity 尽量缩短时间差。协议支持 Multicall 时优先采用；否则必须在 Swap 后重新 Read Current Price 并验证 Position Ratio。

---

## 43. 建仓失败处理

`Swap 成功 但 Add Liquidity 失败` → 不能立即盲目重复 Swap。进入 `PARTIAL_POSITION`，重新读取 Wallet Token Balance 与 Pool Price，再重新计算 Required LP Ratio。

---

## 44. 状态机

V1 状态：

```text
IDLE
SELECT_POOL
PREPARE_POSITION
SWAP
ADD_LIQUIDITY
MONITOR
OUT_OF_RANGE
UNDERPERFORMING
SEARCH_REPLACEMENT
EXIT_POSITION
SWITCH_POOL
RISK_REVIEW
GLOBAL_RISK_OFF
PAUSED
ERROR
```

---

## 45. 主流程

```text
START
↓
LOAD PORTFOLIO
↓
CHECK GLOBAL RISK
↓
NO ACTIVE POSITION?
  YES → SELECT_POOL → PREPARE_POSITION → SWAP → ADD_LIQUIDITY → MONITOR
  NO  → MONITOR
```

---

## 46. MONITOR 核心任务

```yaml
monitor:
  portfolio_interval_minutes: 5
```

每轮检查：Wallet Balance、LP Position、Current Price、NAV、Reserve Ratio、Current Range、Unclaimed Fees、Token Peg、Pool TVL、Pool Liquidity、Emergency Risk。

---

## 47. 正常价格行为

假设 `QQQB = $740`，`Range = $630 - $860`：

```text
Price = 700  → 不操作
Price = 780  → 不操作
Price = 820  → 进入观察状态，但不 Rebalance
```

---

## 48. 禁止 Mid-Range Rebalance

V1 禁止 `价格偏离中心 → 重新居中`，因为频繁 Rebalance 会制造 Realized IL、Swap Costs、Slippage、Gas。

---

## 49. Near Boundary

```text
RangeProgress = (Current - Lower) / (Upper - Lower)
```

`RangeProgress > 0.80` 或 `< 0.20` → 进入 `BOUNDARY_WATCH`，但不立即操作。

---

## 50. Upper Out of Range

`Price >= Upper` → LP 会逐渐变为 Stablecoin。行为 `OUT_OF_RANGE_UP`：

1. 不立即追涨重新买 Token
2. 记录 Position
3. 等待价格稳定
4. 重新运行 Pool Scanner

建议等待 12 ~ 24 Hours。

---

## 51. Lower Out of Range

`Price <= Lower` → LP 会逐渐变为 Stock Token。行为 `RISK_REVIEW`。不能自动立即卖出。

---

## 52. Lower Boundary Risk Review

检查：Underlying Stock 是否同步下跌、Token 是否脱锚、Issuer 是否正常、Redemption 是否正常、Pool TVL 是否正常、Onchain Liquidity 是否正常。

---

## 53. 普通市场下跌

```text
Stock Token Price ↓ 且 Underlying NAV 同步 ↓ 且 Token/NAV 正常
→ MARKET_RISK，默认 HOLD
```

---

## 54. Token 脱锚

```text
Deviation = abs( OnchainTokenPrice / ReferenceNAV - 1 )
```

---

## 55. 脱锚等级

```text
< 1%      NORMAL
1% ~ 2%   WARNING
2% ~ 3%   STOP_NEW_CAPITAL
3% ~ 5%   EXIT_REVIEW
> 5%      EMERGENCY_EXIT
```

---

## 56. Market Hours

Reference NAV 判断必须区分 `US Market Open / Closed / Weekend / Holiday`。

不能在 Saturday 直接用 Friday Closing Price 判断 1% Depeg。

---

## 57. 非交易时间 Depeg

闭市期间应使用 Expanded Threshold 或 Alternative Reference Pricing（Related futures、Indicative price、Issuer quote、Market maker price）。

V1 如果无法获得可靠 Reference：`Disable Hard Depeg Exit`，仅报警。

---

## 58. Emergency Risk

直接进入 `EMERGENCY`：

```text
Token Contract Paused
Issuer Redemption Suspended
DEX Pool Liquidity Collapse
TVL Drop > 50%
Unexpected Contract Upgrade
Stablecoin Depeg
Stock Token Depeg > 5%
Oracle Failure
Contract Security Alert
```

---

## 59. TVL 崩溃监控

```text
TVL 24h Drop > 50% → RISK_REVIEW
TVL 24h Drop > 70% → EMERGENCY
```

阈值可配置。

---

## 60. Reserve Ratio Monitoring

正常 `Reserve >= 30%`，允许自然偏离。`Reserve < 25%` → 禁止增加新 LP，但不立即强制 Rebalance。

---

## 61. 收益处理

V1：Fees 不自动复投。目的：降低风险、降低 Compound 频率、增加 Stablecoin 储备、简化 PnL。

---

## 62. Fee Collection

触发条件：`Unclaimed Fees >= $100` 或 `30 Days`。

---

## 63. Fee Token 处理

收到 USDC → 直接进入 Reserve。收到 QQQB → 可按照条件 `QQQB → USDC` 然后进入 Reserve。

---

## 64. Profit Vault

逻辑上区分 Principal Reserve / Profit Reserve：

```text
Initial Reserve = $3000
Realized Fees   = $300
→ Reserve Principal = 3000, Profit Vault = 300
```

---

## 65. 全局风险线

```text
InitialNAV = 10000
最大策略风险 = 15%
Global Risk Level = $8500
```

---

## 66. Global Risk Trigger

`TotalNAV <= InitialNAV × 0.85` → 进入 `GLOBAL_RISK_OFF`。

---

## 67. Global Risk Off 行为

```text
Stop New Positions
Stop Adding Liquidity
Remove Active Liquidity
Collect Fees
Record Assets
Send Critical Alert
```

不一定自动卖掉所有股票 Token；股票 Token 是否卖出由 `RISK_REVIEW` 决定。

---

## 68. 禁止无限补仓

系统必须保存 `InitialStrategyCapital`（例如 $10,000）。禁止因为亏损自动调用外部钱包资金补仓。策略最大资本由用户明确修改。

---

## 69. Pool Replacement

`Expected Net APR < 12% 持续 72h` → `UNDERPERFORMING` → 启动 `SEARCH_REPLACEMENT`。

---

## 70. Replacement Candidate

必须同时满足：

```text
New Pool Passes Risk Filters
New Pool Score > Current Pool Score
New APR Advantage >= 8%
BreakEvenDays <= 14
Cooldown Passed
```

才进入 `SWITCH_POOL`。

---

## 71. Switch Pool 流程

```text
Collect Fees
↓
Remove Liquidity
↓
Read Token Balances
↓
Swap Old Stock Token → Stablecoin
↓
Verify Balance
↓
Select New Pool
↓
Calculate Optimal New Ratio
↓
Stablecoin → New Stock Token
↓
Add Liquidity
↓
Verify Position
↓
Start Cooldown
```

---

## 72. Switching Safety

设置 `max_total_switch_cost` 例如 0.75%。若预计 `SwitchingCost > Capital × 0.75%`，取消换池。

---

## 73. 最低持仓时间

建议 `Minimum Holding Period = 7 Days`，风险事件除外。

---

## 74. Persistence

所有状态必须持久化，不能只存在内存。推荐 PostgreSQL；V1 可用 SQLite。

---

## 75. Position Record

```typescript
Position {
    id
    chainId
    dex
    poolAddress
    token0
    token1
    openedAt
    initialNAV
    entryPrice
    lowerPrice
    upperPrice
    lowerTick
    upperTick
    initialToken0
    initialToken1
    liquidity
    status
    totalFeesUSD
    realizedPnL
    unrealizedPnL
    benchmarkValue
    feeILRatio
}
```

---

## 76. Swap Record

```typescript
SwapRecord {
    txHash
    timestamp
    chainId
    tokenIn
    tokenOut
    amountIn
    amountOut
    expectedAmountOut
    slippage
    priceImpact
    gasCostUSD
    purpose  // BUILD_POSITION | EXIT_POSITION | SWITCH_POOL | FEE_CONVERSION
}
```

---

## 77. Decision Log

所有决策必须保存：

```typescript
DecisionLog {
    timestamp
    state
    action
    reason
    currentPool
    candidatePool
    currentAPR
    candidateAPR
    poolScore
    tokenDeviation
    totalNAV
    switchingCost
    breakEvenDays
    result
}
```

必须能够回答：为什么机器人在某一天进行了换池？

---

## 78. Alert System

推荐支持 Telegram / Email / Slack / Web Dashboard。

Critical Alert：Global Risk Trigger、Emergency Exit、Token Depeg、Stablecoin Depeg、TVL Collapse、Contract Error、Transaction Failure、Insufficient Gas、Unknown Position State。

---

## 79. Dashboard

V1 Dashboard 至少显示：

**Portfolio**：Total NAV、Initial NAV、PnL、Realized Fees、Unrealized Fees、Reserve、LP Value

**Current Position**：Pool、Token Pair、Current Price、Lower、Upper、Range Position %、LP Value、Fees、Fee APR、Expected Net APR

**Risk**：Token/NAV Deviation、Reserve Ratio、TVL、Pool Liquidity、Price Impact、Portfolio Drawdown

**Benchmark**：LP NAV、HODL NAV、LP Alpha、IL、Fees、Fee / IL Ratio

---

## 80. 系统模块

```text
PortfolioManager
PoolScanner
PoolFilter
PoolRanker
PriceService
NAVService
PositionPlanner
SwapPlanner
SwapExecutor
LiquidityManager
YieldAnalyzer
RiskManager
SwitchManager
BenchmarkEngine
StateMachine
StateStore
NotificationService
```

---

## 81. Chain Adapter

```typescript
interface ChainAdapter {
    getTokenBalance()
    getNativeBalance()
    getBlockNumber()
    getTransaction()
    sendTransaction()
    estimateGas()
}
```

---

## 82. DEX Adapter

```typescript
interface DexAdapter {
    getPool()
    getPoolPrice()
    getLiquidity()
    getTick()
    quoteSwap()
    executeSwap()
    addLiquidity()
    removeLiquidity()
    collectFees()
    getPosition()
}
```

---

## 83. Pool Data Provider

```typescript
interface PoolDataProvider {
    getPools()
    getTVL()
    getVolume24h()
    getVolume7d()
    getFees24h()
    getFees7d()
}
```

---

## 84. Reference Price Provider

```typescript
interface ReferencePriceProvider {
    getStockReferencePrice()
    getMarketStatus()
    getLatestClose()
    getIndicativePrice()
}
```

---

## 85. Strategy Config

```yaml
strategy:
  capital:
    max_lp_ratio: 0.70
    reserve_ratio: 0.30

  monitor:
    portfolio_interval_minutes: 5
    pool_scan_interval_minutes: 60

  range:
    lower_ratio: 0.85
    upper_ratio: 1.16

  yield:
    target_net_apr: 0.15
    warning_net_apr: 0.12
    warning_duration_hours: 72

  pool:
    min_tvl_usd: 500000
    min_avg_daily_volume_7d: 250000
    min_age_days: 7

  swap:
    max_slippage: 0.003
    max_price_impact: 0.005
    quote_ttl_seconds: 30

  switch:
    min_apr_improvement: 0.08
    max_break_even_days: 14
    cooldown_days: 7
    max_switch_cost_ratio: 0.0075

  risk:
    max_drawdown: 0.15
    peg_warning: 0.01
    stop_new_position: 0.02
    exit_review: 0.03
    emergency_exit: 0.05

  fees:
    auto_compound: false
    min_collect_usd: 100
    collect_interval_days: 30
```

---

## 86. Token Config

```yaml
tokens:
  CORE:
    - symbol: QQQB
      chain: BSC
      contract: "OFFICIAL_ADDRESS"
    - symbol: MSFTB
      chain: BSC
      contract: "OFFICIAL_ADDRESS"
    - symbol: AAPLB
      chain: BSC
      contract: "OFFICIAL_ADDRESS"

  HIGH_VOL:
    - symbol: NVDAB
      auto_trade: false
    - symbol: TSLAB
      auto_trade: false
```

实际生产环境必须填写官方合约地址。

---

## 87. Stablecoin Config

```yaml
stablecoins:
  - symbol: USDC
    priority: 1
  - symbol: USDT
    priority: 2
```

---

## 88. State Machine 示例

```text
IDLE
 |
 | no active position
 v
SELECT_POOL
 |
 | valid candidate
 v
PREPARE_POSITION
 |
 v
SWAP
 |
 v
ADD_LIQUIDITY
 |
 v
MONITOR
 |
 +--------------------------+
 |                          |
 | Healthy                  | Yield Poor
 v                          v
MONITOR               UNDERPERFORMING
                            |
                            v
                    SEARCH_REPLACEMENT
                            |
                     better pool?
                      /          \
                    NO            YES
                    |              |
                 MONITOR      SWITCH_POOL
                                   |
                                   v
                                MONITOR
```

风险路径：

```text
MONITOR
  |
  | Risk detected
  v
RISK_REVIEW
  |
  +------------+
  |            |
Normal       Critical
  |            |
MONITOR     EXIT_POSITION
                |
                v
              PAUSED
```

---

## 89. Scheduler

```text
Every 5 min    Portfolio Monitoring
Every 15 min   Current Pool Health
Every 1 hour   Candidate Pool Scan
Every 6 hours  Yield Recalculation
Every 24 hours Benchmark Snapshot
Every 7 days   Strategy Health Report
```

---

## 90. Weekly Strategy Report

```text
Start NAV
End NAV
PnL
LP Fees
Gas
Swap Cost
Slippage
IL
Benchmark Return
LP Alpha
Fee/IL Ratio
Current APR
Current Pool Score
Best Alternative Pool
Risk Status
```

---

## 91. V1 自动执行权限

允许自动：

```text
Swap Approved Token
Add Liquidity
Remove Liquidity
Collect Fees
Switch Approved Pool
```

禁止自动：

```text
Approve Unknown Contract
Transfer Funds To Unknown Address
Bridge
Borrow
Leverage
Stake Unknown Token
Interact With Unknown DEX
Use Permit For Unverified Contract
```

---

## 92. Wallet 安全

强烈建议 Strategy Wallet 独立于主钱包。账户仅放策略允许损失的资金（例如 $10,000）。

不要在 Bot Wallet 放：长期 BTC、ETH、主账户资产、其他大额 Stablecoin。

---

## 93. Allowance

禁止 Unlimited Approval。推荐 Exact Approval 或设置合理上限。

---

## 94. Private Key

禁止 Private Key 写入源码。至少使用 Environment Variables；生产环境推荐 KMS、Hardware Wallet Signer、Vault。

---

## 95. Transaction Protection

每笔交易前验证：Chain ID、Contract Address、Token Address、Expected Function、Expected Amount、Max Slippage、Deadline、Gas Limit。

---

## 96. Fail Closed

遇到未知状态：`DO NOTHING`，而不是 `Guess and Trade`。

> **无法确认安全，就停止自动交易。**

---

## 97. Idempotency

所有执行操作必须支持 Idempotency，防止网络超时、程序重启、RPC 错误导致重复 Swap / Add Liquidity / Remove Liquidity。

---

## 98. Transaction State

至少记录：

```text
CREATED
SUBMITTED
CONFIRMED
FAILED
REVERTED
UNKNOWN
```

UNKNOWN 状态禁止自动重复执行，必须先 Query Chain 确认。

---

## 99. RPC 容错

推荐至少 Primary RPC + Secondary RPC。数据关键步骤进行 Cross Check。

---

## 100. Price Validation

禁止只使用一个 DEX Spot Price。至少使用 Pool Price + Reference Price。关键风险判断最好 2+ independent sources。

---

## 101. Backtest

正式实盘前必须 Backtest。最低要求：QQQ Historical Data 至少 2~3 年。

模拟 ±10% / ±15% / ±20%，不同 Fee、不同 Volume、不同 Rebalance。

比较：LP / 50-50 HODL / 100% QQQ / 100% Stablecoin。

---

## 102. Simulation

上线前必须运行 Paper Trading，建议至少 14~30 天。

Paper 模式真实读取链上数据、运行 Pool Scanner、执行策略决策，但不发送 Transaction。记录 Virtual Position。

---

## 103. Mainnet Rollout

推荐逐步放量：

```text
Stage 1  $500
Stage 2  $2000
Stage 3  $5000
Stage 4  $10000
```

只有上一阶段达到健康条件才扩大。

---

## 104. Strategy Health

健康：

```text
FeeILRatio > 2
Reserve >= 25%
No Peg Warning
Pool Passes Risk Filter
NAV Drawdown < 10%
Expected Net APR >= 15%
```

---

## 105. Warning

```text
FeeILRatio 1 ~ 2
Expected Net APR 12% ~ 15%
Reserve 20% ~ 25%
Peg Deviation 1% ~ 2%
Pool Volume Decline
```

---

## 106. Unhealthy

```text
FeeILRatio < 1
Expected Net APR < 12%
Peg Deviation > 2%
TVL Rapidly Declining
NAV Drawdown > 10%
```

---

## 107. Critical

```text
NAV Drawdown >= 15%
Peg > 5%
Liquidity Collapse
Issuer Risk
Stablecoin Depeg
Contract Security Event
```

---

## 108. V1 Acceptance Criteria

### Portfolio

- [ ] 正确读取钱包余额
- [ ] 正确读取 LP Position
- [ ] 正确读取未领取 Fee
- [ ] 正确计算 NAV
- [ ] 正确计算 Reserve Ratio

### Pool Scanner

- [ ] 正确读取池 TVL
- [ ] 正确读取 24h Volume
- [ ] 正确读取 7D Volume
- [ ] 正确读取 Fee Tier
- [ ] 正确读取 Active Liquidity

### Pool Filter

- [ ] TVL Filter
- [ ] Volume Filter
- [ ] Token Whitelist
- [ ] Stablecoin Whitelist
- [ ] DEX Whitelist
- [ ] NAV Deviation Filter

### Position Planning

- [ ] 正确计算 Upper / Lower
- [ ] Tick 对齐
- [ ] 正确计算 Token0 / Token1 Optimal Ratio
- [ ] 正确计算 Swap Amount

### Swap

- [ ] Quote
- [ ] Slippage Check
- [ ] Price Impact Check
- [ ] Deadline
- [ ] Balance Verification

### LP

- [ ] Add Liquidity
- [ ] Position Verification
- [ ] Collect Fee
- [ ] Remove Liquidity

### Risk

- [ ] Peg Warning
- [ ] Global Drawdown
- [ ] TVL Collapse
- [ ] Out Of Range
- [ ] Emergency Pause

### Switching

- [ ] Detect Underperformance
- [ ] Search Alternative
- [ ] Compare APR
- [ ] Calculate Switching Cost
- [ ] Break Even Days
- [ ] Cooldown Enforcement

---

## 109. 推荐开发阶段

**Phase 1** 只监控，不交易：Portfolio Manager、Pool Scanner、Pool Ranking、Dashboard、Alert

**Phase 2** Paper Trading：Virtual Swap、Virtual LP、Virtual Switching、PnL、Benchmark

**Phase 3** 单池实盘，只允许 QQQB / USDC：Build Position、Monitor、Exit

**Phase 4** 多池选择，增加 MSFTB、AAPLB、AMZNB、METAB

**Phase 5** 自动换池：Pool Ranking、Switch Cost、Break Even、Cooldown

**Phase 6** 扩展 Chain / DEX：X Layer、RH Chain、Uniswap V4

---

## 110. V1 最终策略摘要

```text
Capital = $10,000
$7,000 Max LP / $3,000 Reserve
```

系统扫描 Approved Stock Token / USDC or USDT 池子。池必须满足：

```text
TVL >= $500k
7D Avg Daily Volume >= $250k
Pool Age >= 7 Days
Peg Deviation < 1%
Swap Impact < 0.5%
```

优先寻找 `Expected Net APR >= 15%`。建立 LP `Lower ≈ -15% / Upper ≈ +16%`。

系统根据 Current Price / Lower / Upper 计算正确的 Stock Token / Stablecoin Ratio，然后 `USDC → Required Stock Token`，再 Add Liquidity。

正常情况下不 Rebalance。价格接近区间边界 → Watch。出上界 → 不追涨、等待、重新扫描 Pool。出下界 → Risk Review。

收益：`7D Net APR < 12% 持续 72h` 开始寻找替代 Pool。只有 `New APR Advantage >= 8%` 且 `Break Even <= 14 Days` 才换池。换池后 7 Days Cooldown。

Token：`Peg > 2% 停止新增`、`Peg > 3% Exit Review`、`Peg > 5% Emergency Exit`。

总资产：`NAV <= Initial NAV × 85%` → `GLOBAL RISK OFF`。

手续费：不自动复投，优先进入 USDC Reserve。

整个策略最终追求：

```text
稳定 Fee 收益
+ 低操作频率
+ 低 Switching Cost
+ 可控 IL
+ 高资金利用率
+ 严格 Token 风险控制
```

而不是 Highest APR。

---

## 111. 核心产品定义

> **Stock LP Auto Strategy 是一个自动寻找高质量股票代币流动性池，并根据集中流动性数学进行最优资金配置，在严格控制脱锚、无常损失、滑点、池子质量和账户回撤的情况下获取 LP 手续费收益的自动资产管理系统。**

---

## 112. 开发原则

```text
Safety > Yield
Risk Filter > Pool Ranking
Net APR > Frontend APR
NAV > Wallet Balance
Contract Address > Token Symbol
Optimal LP Ratio > Fixed 50/50
Hold > Frequent Rebalance
Stable Yield > APR Chasing
Fail Closed > Guess And Trade
```

---

**End of V1.0 Strategy Specification**
