# 链上与依赖事实调查（2026-09-29）

**性质**：只读外部调研记录（三个独立 scout 并行完成），供 Iteration 1 实现使用。
**证据等级**：`[官方]` = 发行方/协议官方来源；`[实测]` = 本次调研中实际发起的 HTTP/链上调用返回；`[推断]` = 由上述推导；`[未找到]` = 明确未找到。

> 本文件的每条结论都**必须在实现期由代码再次验证**（§108 验收要求运行证据）。此处记录的是"实现前的最佳已知事实"，不是已验证的实现结果。

---

## 1. 股票代币身份：Binance bStocks

**发行方**：BTECH Holdings Ltd（ADGM 注册 SPV，Binance 集团关联方）；产品名 **bStocks**。`[官方]`
排除：Backed Finance bTokens、xStocks（`QQQx`）、Dinari、Ondo（`QQQon`）—— BNB Chain 官方把它们列为不同发行方。

**合约地址白名单（chainId 56，全部 18 decimals）** `[官方]`：

| symbol | 合约地址 | 备注 |
|---|---|---|
| QQQB | `0x205812CdBed920aFf76C6580abD681a46D11efc7` | 链上 name = `Invesqo QQQ`（注意拼写） |
| MSFTB | `0x80106cb3ead06659a5ad19df39d9b4733863b9b0` | |
| AAPLB | `0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a` | |
| AMZNB | `0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00` | |
| METAB | `0x7425889fe94f9d693e8daefe88bcced6acfef4c0` | |
| NVDAB | `0x02fca66c1d1afb4e2a7884261eb00f63598a7436` | |
| TSLAB | `0x5b1910eaad6450e50f816082aa078c41f10c292f` | |
| PLTRB | `0x0ca5d51d0277bd006fd9607d3e560785ebad8222` | |

来源：Binance Proof of Collateral 页 `https://www.binance.com/proof-of-collateral/bstocks`（地址截断显示）+ Binance 上币公告（完整地址）+ GeckoTerminal 按地址回读 `name/symbol/decimals` 交叉验证。

**白名单必要性的实测证据** `[实测]`：
- 同链并存同标的异物：`QQQB`(bStocks) / `QQQx`(xStocks) / `QQQon`(Ondo)。
- 疑似冒充地址（不在官方列表）：`0xb904108b7f6d3b27c23128ca2b62738061b8a689`。
- 同一 symbol 存在多个 8-decimals 的 `"… Tokenized bStocks"` 相似合约（TSLAB/AMZNB/MSFTB 各有 2–4 个）。
- 链上 ticker 大小写不统一（registry 回读 `msftb`/`metab`/`pltrb` 为小写）→ **`symbol == "MSFTB"` 这种比较不可用**。

**稳定币（chainId 56，均 18 decimals，均 Binance-Peg）** `[实测]`：

| symbol | 地址 | 备注 |
|---|---|---|
| USDC | `0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d` | **非 Circle 原生**；Binance-Peg |
| USDT | `0x55d398326f99059ff775485246999027b3197955` | Binance-Peg |
| WBNB | `0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c` | |

> ⚠️ **BSC 上 USDC/USDT 是 18 位小数，不是 6 位**。硬编码 6 会产生 $10^{12}$ 级错误。

---

## 2. BEP-677 / EIP-8056 Scaled UI Amount（**实现必读，最高风险项**）

bStocks 是 BEP-20 + **BEP-677 Scaled UI Amount**。分红、拆股**不增发、不转账**，只改 `uiMultiplier()`。`[官方]`

```text
UI amount = rawAmount × uiMultiplier / 1e18
UI price  = rawPrice × 1e18 / uiMultiplier   ← 仅当价格源以 raw token 计价
```

**实现要求**：
1. 余额/份额一律用 `balanceOfUI(address)`（回退 `balanceOf() * uiMultiplier() / 1e18`）；`totalSupplyUI()` 同理。
2. 用户输入/输出金额走 `toUIAmount()` / `fromUIAmount()`；注意官方声明往返**非无损**（`fromUIAmount(toUIAmount(x)) <= x`）。
3. 订阅 `UIMultiplierUpdated` / `UIMultiplierChangeOverwritten` / `TransferWithUIAmount`；`effectiveAtTimestamp` 可被后续调用**提前覆盖** → 不得把已公告的 `effectiveAt` 当作风险窗口依据。
4. 企业行动（ex-date）会暂停 deposit/withdrawal/conversion；拆股时 spot 交易也暂停 → LP 策略必须在**生效窗内停摆**（对应基线 §58 Emergency / RISK_REVIEW）。
5. ERC-165 探测 ID：core `0xa60bf13d`、newUIMultiplier `0x4bd27648`、conversion `0x57854fc3`、balances `0xd890fd71`、BSC scheduled `0xeb0093dd`。
6. **禁止硬编码 `uiMultiplier = 1e18`**，运行期读取。`[实测]` 当前值未读取（无可用读通道），实现期首件事就是读它。

**其他属性**：`[推断]` 合约支持发行方黑名单/冻结（官方 FAQ 自述，ABI 未实证 —— Sourcify/Blockscout 404、BscScan 403）；不对 US persons 提供，集成方有 geo-blocking 义务。

---

## 3. 参考价（Reference NAV）来源

**发行方没有公开的链上 NAV / 赎回价 API** `[官方]`。官方赎回语义是「在 Binance 平台内按标的股票市价 1:1 转换」，非链上可读。

**Binance bStocks index price（官方定义的权威参考）** `[官方]`：
- 盘中：第三方实时美股价 + Binance 期货价加权（权重见 API 响应）。
- 非盘中（周末/假期/维护窗）：**定格在最近一次美股收盘的最后有效价，直到下一交易时段开始**。
- 端点 `GET https://fapi.binance.com/fapi/v1/constituents?symbol=<TICKER>USDT` —— `[实测]` 已成功返回 `constituents[]`（含权重）。**必须处理 `price <= 0` / `"-1"` 占位无效值。**
- 现货 `GET https://api.binance.com/api/v3/ticker/price?symbol=TSLABUSDT` —— `[实测]` 返回真实价。

**链上预言机** `[官方]`：
- **APRO（AggregatorV3 兼容 push feed，BSC，1% 偏差 / 1h 心跳）**：QQQB `0x2708567c468db65a72095716FCff023dcDfEA07A`、NVDAB `0x310EFC9Fefe89B8085F89E91Ac782Bef6416499E`、TSLAB `0xe1bc21701Bc8FFa39DaecDb8f58263C1d5e1c0bc`、METAB `0x32Fd1E5E20b091Df7286EE8C69937C4A8D619885`、MSFTB `0xBC92F296c48E31409eD4DbD638F1fbe0ee5A3724`、PLTRB `0xBb0535d8C1B1adB790beD2d9b84d4Dbc78fdD902`。**AAPLB / AMZNB 无 APRO feed。** `latestRoundData()` 未实测。
- **Atlas Oracle**：Venus 的 MAIN 源，接口与 Chainlink AggregatorV2/V3 线级兼容；但每个 feed 处于 `whitelist` 或 `open-read` 模式，需先调 `isOpenRead()` / `isAuthorizedCaller()` 判断。已知地址仅 TSLAB `0x63950c265e7cdb4016ba60c288c46291c0148ce2`、NVDAB `0x8a44cf4e55add99eb8bac5d5db749c63106d54aa` 等 4 个。
- **Chainlink BSC 股票 feed（美股参考价，8 位小数，24h 心跳）**：AAPL `0xb7Ed5bE7977d61E83534230f3256C021e0fae0B6`、AMZN `0x51d08ca89d3e8c12535BA8AEd33cDf2557ab5b2a`、MSFT `0x5D209cE1fBABeAA8E6f9De4514A74FFB4b34560F`、META `0xfc76E9445952A3C31369dFd26edfdfb9713DF5Bb`、NVDA `0xea5c2Cbb5cD57daC24E26180b19a929F3E9699B8`、TSLA `0xEEA2ae9c074E87596A85ABE698B2Afebc9B57893`、QQQ `0x9A41B56b2c24683E2f23BdE15c14BC7c4a58c3c4`、SPY `0xb24D1DeE5F9a3f761D286B56d2bC44CE1D02DF7e`。**PLTR 无 feed。**
  ⚠️ Chainlink 官方 Tokenized Equity 目录只有 Ondo / Robinhood / Coinbase，**不含 bStocks** → 这些是**美股参考价**，不能当 bStock 代币价直接消费。存活/小数未实测。
- 稳定币 feed：Chainlink USDC/USD BSC `0x8068600c8f6d2fB3d44F5B4cb7E7f4Ac47c2c742`（**18 位小数**）vs USDT/USD `0xB97Ad0E74fa7d920791E90258A6E2085088b4320`（**8 位小数**）→ **归一化极易出错**。

**闭市期间口径（对应基线 §56–§57）**：优先 Binance index price（其官方行为就是闭市定格）；若不可得则按基线降级为「报警不硬平仓」。`fapi` 的 `/constituents` 在部分时段可能返回占位无效值，必须实现 `price<=0` 判定与回退。

---

## 4. 池子实况与数据源

### 4.1 实际存在的 QQQB 池（`[实测]`，2026-09-29 ~09:46–09:52 UTC）

| 池 | 地址 | DEX | Fee | 创建 | TVL | 24h Vol |
|---|---|---|---|---|---|---|
| **QQQB / USDC** | `0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e` | **Uniswap V3 (BSC)** | 0.3% | 2026-08-07 | $1.77M | $1.34M |
| **QQQB / USDT** | `0xe531fcb1f5a195de7608b9f4f9518544c2cdb693` | **PancakeSwap V3** | 0.01% | 2026-07-10 | $0.622M | $6.56M |
| QQQB / WBNB | `0x47bc06722295ac316a569eef87ac32faa455f441` | PancakeSwap V3 | 0.05% | 2026-07-14 | $0.820M | $6.93M |
| QQQB / USDT | `0x62609d8964b2fb5ce0322c4e0b659466e7297df903633c0e3fdb2c7fed0c84c9` | Uniswap **V4** | 0.003% | 2026-07-11 | n/a | n/a |

> ⚠️ **不存在 PancakeSwap V3 的 QQQB/USDC 池**。按 spec 字面「PancakeSwap V3 + QQQB + USDC」扫描会得到 0 行。
> 基线 §12 的 DEX 白名单（Uniswap V3 + PancakeSwap V3）与 §110 的「USDC 或 USDT」already 覆盖上述前两条 → **无需改产品范围**，两条都在范围内，由 Scanner 排序决定。

**BSC 上 Uniswap V3 合约地址** `[官方]`：Factory `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7`、NonfungiblePositionManager `0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613`、SwapRouter02 `0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2`、QuoterV2 `0x78D78E420Da98ad378D7799bE8f4AF69033EB077`、TickLens `0xD9270014D396281579760619CCf4c3af0501A47C`、Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`、UniversalRouter `0x1906c1d672b88cd1b9ac7593301ca990f94eae07`。

**PancakeSwap V3 合约地址** `[官方]`：

| 合约 | 地址 | 包常量 |
|---|---|---|
| PancakeV3Factory | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` | `FACTORY_ADDRESSES[56]` |
| PancakeV3PoolDeployer | `0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9` | `DEPLOYER_ADDRESSES[56]` |
| NonfungiblePositionManager | `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364` | `NFT_POSITION_MANAGER_ADDRESSES[56]` |
| SwapRouter (v3) | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` | **无导出常量** |
| SmartRouter | `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4` | `SMART_ROUTER_ADDRESSES[ChainId.BSC]` |
| QuoterV2 | `0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997` | `V3_QUOTER_ADDRESSES[56]` |
| TickLens | `0x9a489505a00cE272eAa5e07Dba6491314CaE3796` | `V3_TICK_LENS_ADDRESSES[56]` |
| TickQueryHelper | `0x5BF1597ebfB079c3D47918b1B77eaE2475803D7A` | `TICK_QUERY_HELPER_ADDRESSES[56]` |
| PancakeInterfaceMulticall | `0xac1cE734566f390A94b00eb9bf561c2625BF44ea` | 无 |
| MixedRouteQuoterV1 | `0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86` | 无 |
| Universal Router (v3, NFT-capable) | `0x1A0A18AC4BECDDbd6389559687d1A73d8927E416` | 无 |
| **Permit2（Pancake 自有部署）** | `0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768` | 无 |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | `viem/chains` |

> ⚠️ Pancake 的 Permit2 **不是** Uniswap canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3`。
> ⚠️ `@pancakeswap/chains@0.10.0` 的 chain 56 条目**无 `contracts` 块**（`getChainConfig(56).contracts === undefined`）→ 地址必须从 v3-sdk 常量映射 + smart-router 常量取。

### 4.2 原子 swap + addLiquidity 路径（`swapAndAddCallParameters`）`[官方]`

```ts
SwapRouter.swapAndAddCallParameters(
  trade: SmartRouterTrade, position: Position, addLiquidityOptions: AddLiquidityOptions,
  tokenInApprovalType: ApprovalTypes, tokenOutApprovalType: ApprovalTypes,
): MethodParameters   // { calldata: Hex; value: Hex }
// SwapAndAddOptions = { slippageTolerance: Percent; recipient?; deadlineOrPreviousBlockhash?: Validation; ...permit options }
```

- **单笔交易发往 SmartRouter**（`to = 0x13f4EA83…`，native 腿走 `value`）。
- swap 输出如何进入 addLiquidity：`encodeSwaps(..., isSwapAndAdd=true)` 强制 `routerMustCustody=true`，每条 swap 腿 `recipient = ADDRESS_THIS`；随后 router `pull` 用户缺少的 position token → 链上 approve position manager → `callPositionManager` → NPM `mint`/`increaseLiquidity`，剩余以 `sweepToken(amountMinimum=0)` 退回。
- **slippage 可在原子调用内强制**：`options.slippageTolerance` 转成每条 swap 腿的 `amountOutMinimum`/`amountInMaximum`，同时为 addLiquidity 生成 `amount0Min`/`amount1Min`（经 `minimalPosition`）。**0.3% slippage 上限可落地。**
- **price impact 不可在调用内强制**：SDK 无该参数，只在内部用于决定是否追加 `refundETH`（`SwapRouter.riskOfPartialFill`）。**0.5% price impact 上限必须由调用方在编码前用 QuoterV2 / trade 的 input-amount vs pool mid price 自算出并 abort。**
- 候选池与报价的**无 key 路径**：`InfinityRouter.getV3CandidatePools({ clientProvider, currencyA, currencyB })` + `InfinityRouter.getBestTrade(amount, to, TradeType.EXACT_INPUT, { gasPriceWei, candidatePools })`（链上读池 + 链下算价，不依赖 subgraph）。**legacy `SmartRouter` 路径才需要 Graph key。**
- 机器人专用要点：原子性**仅 SmartRouter 具备**（v3 SwapRouter / NPM 的 `multicall` 是 self-delegatecall，不能 swap）；`deadlineOrPreviousBlockhash` 支持 `bytes32 previousBlockhash` 变体（无人值守首选，避免时钟偏移 revert）；BSC USDT 用 `ApprovalTypes.ZERO_THEN_MAX`（approve-from-nonzero 保护）；native 腿需断言 `WNATIVE[56] === WBNB`；**无写路径 gas 助手**（`multicallByGasLimit` 只服务读/quote 路径）→ 自行 `estimateGas`，并把 `gasPriceWei` 传给 `getBestTrade` 让路由 gas-aware；需 surfacing 的 revert：`TOKEN_IN_DIFF`/`TOKEN_OUT_DIFF`/`TRADE_TYPE_DIFF`（同批 trade 必须同 input/output currency）、`NON_TOKEN_PERMIT_OUTPUT`、`ZERO_LIQUIDITY`、`TICK_ORDER`/`TICK_LOWER`/`TICK_UPPER`。

### 4.3 池子存在的 Uniswap V3 侧接口 `[官方]`

Factory `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7`、NonfungiblePositionManager `0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613`、SwapRouter02 `0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2`、QuoterV2 `0x78D78E420Da98ad378D7799bE8f4AF69033EB077`、TickLens `0xD9270014D396281579760619CCf4c3af0501A47C`、Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`、UniversalRouter `0x1906c1d672b88cd1b9ac7593301ca990f94eae07`。
**对应 SDK 侧用 viem 自实现最小数学**（不引入 `@uniswap/v3-sdk`，理由见 §5）。

### 4.4 数据源分层（`[实测]`）

| 层 | 源 | 覆盖 | 限制 |
|---|---|---|---|
| 池发现 + 基础统计 | **GeckoTerminal**（无 key） | poolAddress、token0/1、feeTier、TVL、vol h24/h6/h1、createdAt、daily OHLCV（全历史） | **~10 req/min，实测遇 429**；**无 tick / liquidity / fees / 7d-30d volume** |
| 池发现 + 7d/30d volume | **DexPaprika**（无 key / 免费 key） | poolAddress、TVL、vol 24h/6h/1h、created_at、**volume_usd_7d/30d**、OHLCV | `fee` 字段对 V3 返回 **null**；OHLCV 深度按 key 等级（keyless 24h / 免费 key 7d） |
| 参考价 | **DefiLlama**（无 key） | `/prices/current/bsc:{addr}`、`/percentage/{coins}`、historical | — |
| **tick / liquidity / fee** | **BSC RPC `eth_call`** | `slot0()`→sqrtPriceX96,tick；`liquidity()`；`fee()`；`token0/1()` | 官方 dataseed 端点**禁用 `eth_getLogs`** |
| 池历史（tick/liquidity/fees 序列） | PancakeSwap V3 subgraph（需 The Graph key，免费 100K q/mo） | 全套 CLMM 真值 + PoolDayData/PoolHourData | 免费 key；keyless 无路径 |
| TVL 崩溃流 | DexPaprika SSE `/sse/reserves`（免费 key） | 区块级储备变动 | — |
| DefiLlama `/pools` | — | **不索引 QQQB 任何池**（全文 grep 零命中，`[实测]`） | 不可用于发现 |
| Etherscan V2 / BscScan | — | **BNB Chain 被标为 paid-tier only** `[官方]` | 不可用 |
| Birdeye | 需 key | OHLCV/价格 | 免费额度按 compute units 计，非请求数；`[推断]` 细节未直读 |

**结论**：`tick` 与 `liquidity` 是**任何免费 HTTP API 都不提供**的两个字段，而它们正是 CL 策略不可伪造的输入 → **必须实现链上读取层（viem `eth_call` / multicall）**。`fees24h/7d` 只能由 `volume × feeTier` 推导或走 subgraph。

**RPC（免费额度）** `[官方]`：Alchemy 30M CU/mo、25 req/s、含 archive；Ankr 200M credits/mo、≈30 req/s，但 BSC `eth_getLogs` 区块范围上限 1000；NodeReal 文档自相矛盾（10M vs 100M CU）→ 按 10M 保守；QuickNode 仅 30 天试用且 `eth_getLogs` 限 5 区块。

---

## 5. TS 依赖事实

**链访问**：`viem@2.57.0`（2.x 为生产选择；3.x 仅 `next.12` 预发布）。viem 内置 `bsc`(56) / `bscTestnet`(97) chain 定义，`multicall3` 地址 `0xcA11bde05977b3631167028862bE2a173976CA11`（与 Pancake 自家 multicall3 一致）。`[官方]`

**Pancake V3 SDK：存在且活跃** `[官方]`：`@pancakeswap/v3-sdk@3.10.3`（2026-09-28 发布），依赖**精确锁定** `viem 2.37.13`（非 range）。配套 `@pancakeswap/smart-router@7.8.0`（含**原子 `swapAndAddCallParameters`**）、`@pancakeswap/chains@0.10.0`、`@pancakeswap/sdk@5.9.3`、`@pancakeswap/tokens@0.10.0`、`@pancakeswap/multicall@3.8.3`。

**与 `@uniswap/v3-sdk@3.31.5` 不互通** `[官方]`：JSBI vs bigint；ethers `Interface` vs viem const ABI；**fee tier 不同（Pancake 100/500/2500/10000、tickSpacing 1/10/50/200；Uniswap 含 3000/60）**；池地址推导用 **PoolDeployer** 而非 Factory，init code hash 不同；`FeeAmount` 跨包传递会**静默选错池**。
→ 决策：**一个 SDK 家族**。Pancake 用官方 SDK；Uniswap 侧用 viem + 官方地址自实现最小数学，**不共享任何 SDK 对象**。

**仓位数学命名纠偏** `[官方]`：`getLiquidityForAmounts` / `getAmountsForLiquidity` 是 **Solidity** 函数（v3-periphery `LiquidityAmounts.sol`），**TS SDK 不导出**。TS 等价物是 `maxLiquidityForAmounts(...)` / `maxLiquidityForAmount0*` / `SqrtPriceMath.getAmount0Delta|getAmount1Delta` / `Position.amount0|amount1|mintAmounts`。tick 对齐由 `Position` 构造函数断言强制（`tick % pool.tickSpacing === 0`），配合 `nearestUsableTick(tick, pool.tickSpacing)`。Pancake 额外提供 `FeeCalculator.*`（含 `getEstimatedLPFee*`）与 `PositionMath.getToken0Amount/getToken1Amount`。

**风险（按优先级）** `[官方+推断]`：
1. `@pancakeswap/v3-sdk` 精确锁定 `viem 2.37.13` → 应用若用 viem 2.57 会装出两份 viem（类型冲突/体积翻倍）→ **对齐到 2.37.13** 或加 overrides 并做真实读写冒烟。
2. fee tier 跨包混用静默选错池。
3. BSC USDC/USDT 18 decimals（不是 6）。
4. `@pancakeswap/chains@0.10.0` 的 `getChainConfig(56).contracts` **为 undefined** → 地址必须从 v3-sdk 常量映射 + smart-router 常量取，否则**运行期**才炸。
5. `@pancakeswap/v3-sdk` **不导出 v3 SwapRouter 地址**，只导出 ABI。
6. Pancake V3 SwapRouter/NPM **不支持 Permit2**（Permit2 只接在 Universal Router 上）；
7. `@pancakeswap/routing-sdk` 在 npm 上 **404**（README 提到的未来替代品不存在）。
8. BNB 官方 RPC 禁用 `eth_getLogs`；Ankr 限 1000 区块；QuickNode 免费试用限 5 区块 → 事件驱动设计必须小窗口分页或 WS。

**私钥加密** `[官方]`：`node:crypto` 足够，**无需额外依赖**。AES-256-GCM + scrypt；OWASP 推荐 Argon2id（`m=19MiB, t=2, p=1`），Node ≥ 24.7 才有内置 `crypto.argon2`。
⚠️ **陷阱**：`scryptSync` 默认 `maxmem = 32MiB`，而 `N=2^17, r=8` 需要 128 MiB（`128*N*r > maxmem` 即抛错）→ 必须显式抬 `maxmem`（或降 `N` 到 `2^15, r=8, p=3`）。

---

## 6. 未决 / 待实现期验证

| 项 | 状态 |
|---|---|
| 各 bStock 当前 `uiMultiplier()` 实际值 | 未读取 → 实现期首件事 |
| APRO / Chainlink feed 的 `latestRoundData()` 存活与 decimals | 未实测 → 上线前逐条 probe |
| bStocks 合约 ABI（blacklist / upgradeable） | 未实证（Sourcify/Blockscout 404、BscScan 403） |
| Circle 原生 BSC USDC 地址 | 未找到官方来源 |
| Binance SAPI `/sapi/v1/equity/market/tokenized-assets`（官方资产清单+乘数） | 文档已证，直连 400（缺 key）→ 待补 key 验证 |
| Pancake SmartRouter 原子路径的 slippage/price-impact 约束能力 | §5 待补（已向调研 agent 追问） |
