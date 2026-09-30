# lptrader 产品文档

**本文件是本产品唯一的权威定义。** 描述"产品是什么"，不描述"改动历史"。
**功能实现状态**见 [`feature-list.md`](feature-list.md)；**不做版本对比**。
**规则条款（阈值、门槛、分级）以实现为准**，本文引用而不重复定义。

---

## 1. 产品是什么

> **一个自动管理股票代币集中流动性（LP）仓位的资产管理系统，以风险控制为第一优先级。**

它不是一个追逐最高 APR 的 Yield Farming 机器人。同等条件下，**选择风险更低的池**，而不是收益更高的池。

### 1.1 自动完成的闭环

```text
① 发现      从白名单股票代币出发，自动发现其 USDT/USDC 池
② 筛选      按硬性门槛过滤，精筛出可建仓的池
③ 建仓      计算最优比例 → 报价 → 确认 → swap + addLiquidity
④ 监控      实时权益、区间位置、未领手续费、脱锚、TVL
⑤ 风控      分级判定；灾难级自动撤池，其余推送人工判断
⑥ 换池      撤池后重新选池 → 重新建仓 → 回到监控
```

**⑥ 是闭环的关键**：没有它，系统只是一次性的（建一次仓、监控、退出，然后结束）。

### 1.2 人在回路中的位置

**人是监督者，不是操作者。** 系统的默认行为是自动的；人只在以下时刻介入：

| 时刻 | 人的动作 | 为什么需要人 |
|---|---|---|
| 建仓 | 确认 Approve/Reject | 第一次投入资金不可逆 |
| 换池 | 确认（成本上限内） | 涉及两次 swap 成本与已实现 IL |
| 区间出界 | 人工判断是否撤池 | 此时仓位几乎全是股票代币，撤池等于卖在低点 |
| 风控停机后 | `/resume` 显式放行 | "我接受现状"与"重新投钱"是两个决定 |
| 注资 | 手动转入 | §68 禁止自动补仓 |

**不需要人确认的**：灾难级自动撤池（§67，等人本身就是风险）。

---

## 2. 产品不是什么（明确不做）

**V1 排除**：高频交易、股价预测、AI 方向预测、杠杆、借贷、Delta Neutral、Futures Hedge、高频 Rebalance、自动追涨、自动补仓、无限制 Compound、未授权 Token 自动发现、多链。

**架构上的"不做"**：

| 不做 | 理由 |
|---|---|
| 按 symbol 解析代币 | 同链存在同 symbol 异物；**Contract Address 是唯一标识**（§8） |
| 用前端 APR | 前端 APR 含不可持续激励；自行计算 Net APR（§17） |
| 硬编码 `uiMultiplier = 1e18` | bStocks 是 BEP-677 Scaled UI Amount，运行期读取 |
| 模块 1 读链 | 纯 HTTP；链上验证归模块 2 |
| 在数据缺失时按 0 比较 | §96 fail closed：`*_UNAVAILABLE` 而非"太小" |

---

## 3. 系统结构

```text
┌─ 模块 1 · 池子发现 ──────────────────────── 纯 HTTP，每 60 分钟 ─┐
│  股票代币白名单 → 其 USDT/USDC 池 + 基础信息 → 落库为时序        │
└─────────────────────────────────────────────────────────────────┘
                            │ 候选池（按 APR 排序）
                            ▼
┌─ 模块 2 · 逐池精筛 ──────────────────────── 链上，按需（建仓前）──┐
│  逐个读链验证 → 首个通过全部门槛的池 → 进入建仓                   │
│  首个合格即停止，不遍历全部                                       │
└─────────────────────────────────────────────────────────────────┘
                            │ 选定的池
                            ▼
┌─ 模块 3 · 持仓监控与风控 ────────────────── 链上，5min + 15min ──┐
│  实时权益 / 区间 / 未领 fee / 脱锚 / TVL / 回撤                  │
│  判定 → 灾难级自动撤池；其余推送人工                              │
└─────────────────────────────────────────────────────────────────┘
                            │ 风控触发
                            ▼
┌─ 模块 4 · 换池 ──────────────────────────── 事件驱动 ────────────┐
│  撤池 → 回到模块 2 选池 → 建仓 → 回到模块 3                       │
└─────────────────────────────────────────────────────────────────┘
```

**分层原则**：模块 1/2 是**筛选层**（便宜、可失败、可缓存）；模块 3/4 是**执行层**（贵、必须成功、涉及资金）。两者失败语义不同。

---

## 4. 对象与数据

### 4.1 池

**唯一标识**：`chainId + dex + poolAddress`（§13）。**不用 symbol。**

| 字段 | 来源 |
|---|---|
| 池地址 / DEX / feeTier | GeckoTerminal `/tokens/{addr}/pools` |
| TVL | GeckoTerminal `reserve_in_usd`（canonical） |
| volume 24h | GeckoTerminal |
| volume 7d | DexPaprika（GT 无此字段） |
| pool age | GeckoTerminal `pool_created_at` |
| APR 24h/7d | **本地计算**（§17） |

冲突时取 GT 为 canonical，另一值记入 `crossChecks` 供审计。

### 4.2 仓位

- 单一仓位（多仓是故障，不是状态）
- 记录 `initialToken0/1`、`liquidity`、区间、tokenId
- 余额/份额/金额**一律经 UI 换算**（BEP-677）

### 4.3 NAV

```text
NAV = Wallet Balance + LP Position Value + Unclaimed Fees
```
**NAV 是唯一权益口径**，不是钱包余额（§5）。

### 4.4 Benchmark（§6）

建仓时按同比例构造 Buy & Hold 对照组合。**IL 与 Fee/IL Ratio 由 Benchmark 差分得出** —— 因此 Benchmark 不是可选项。

---

## 5. 规则

> 阈值与公式的**权威定义在实现与配置中**；本节给出规则的作用，便于理解系统行为。

### 5.1 资产白名单（§8–§12）

| 白名单 | 内容 |
|---|---|
| 股票代币 | 8 个 bStock（地址为主键，运行期读 `uiMultiplier`） |
| 稳定币 | USDC、USDT（USDT 优先） |
| 链 | BNB Chain（56） |
| DEX | PancakeSwap V3、Uniswap V3 |

**候选池由 Scanner 从白名单安全交叉集自动发现**，不写死单一组合。

### 5.2 硬性过滤（§16）

| 条件 | 阈值 | 备注 |
|---|---|---|
| TVL | ≥ $500,000 | |
| 7D 平均日成交量 | ≥ $250,000 | |
| 池龄 | ≥ 配置值 | |
| Token/NAV 偏离 | < 1% | |
| $3500 换手价格影响 | < 0.5% | 以 §110 资金规模计 |

**两段式**：模块 1 评 HTTP 可判项（TVL/volume/age/白名单）；模块 2 评链上项（NAV 偏离 / swap impact / tick 对齐）。**准入段不把"尚未测"记为"失败"**。

**§96 fail closed**：数据缺失 → `*_UNAVAILABLE`，不按 0 比较。

### 5.3 建仓数学（§33–§38）

- Range：CORE 股票代币默认 下界 = 当前价 × 0.85，上界 = × 1.16
- Tick 对齐（§34）
- **不采用固定 50/50 swap**，按集中流动性最优比例（§35/§37/§38）
- §42 **原子建仓**：swap + addLiquidity 一笔交易；只有 PancakeSwap V3 支持

### 5.4 风控分级

| 情形 | 等级 | 动作 |
|---|---|---|
| 脱锚 > 阈值 | 分级 | 推送 |
| TVL 崩溃 > 70% | 高 | **自动撤池** |
| 全局回撤触及 §66 线 | 灾难 | **自动撤池** + GLOBAL_RISK_OFF |
| 紧急事件（§58） | 灾难 | **自动撤池** |
| 区间出界（§8.6） | 中 | **人工判断**（撤池等于卖在低点） |

### 5.5 换池（§28–§32）

**注意区分两类换池**：

| 类型 | 触发 | 门槛 |
|---|---|---|
| **风控驱动** | 脱锚 / TVL 崩 / 紧急 | **风控事件豁免冷却与收益门槛**（§32 明确） |
| **收益驱动** | 7D Net APR < 12% 持续 72h | 需满足：新池高出 8 个百分点、BreakEven ≤ 14 天、7 天冷却 |

**风控驱动的换池是必要的，不是优化。**

---

## 6. 操作面（Telegram）

### 6.1 命令

| 命令 | 作用 |
|---|---|
| `/start` | 空仓时手动发起建仓（走与自动路径相同的选池逻辑） |
| `/exit` | 撤出当前仓位；撤完自动重新选池 |
| `/resume` | 风控停机后人工放行 |
| `/status` | 状态、模式、节拍 |
| `/position` | 持仓池、区间、未领手续费 |
| `/pools` | 当前候选池与其过滤结果 |
| `/nav` | 总资产、储备、LP 价值 |
| `/risk` | 脱锚、储备比例、TVL、回撤 |

### 6.2 启动输出（必须的确认项）

```text
mode       : READ-ONLY / LIVE
cadences   : pool-scan=60m portfolio-monitor=5m pool-health=15m
keystore   : 配置与否
dry-run    : yes/no

未决交易 WARNING（若有）
```

**只读模式是真实模式**：无签名者时只读运行（可扫描、落库、估值、判风控、告警），但**不能写**，且启动输出明确说明。

**口令错误 = 硬失败退出**，不降级为只读（降级会让你以为能交易而实际不能）。

---

## 7. 验收标准

**唯一有效的验收方式：真实入口 + 可观察结果。**

```text
一条功能算完成，当且仅当：
  npm run dev 运行时，该功能走到「待广播交易已构造」或「明确的拒绝原因」
```

**不属于验收**：函数存在、单元测试通过、typecheck 通过、dry-run 离线算出数字。

| 闭环环节 | 验收方式 |
|---|---|
| 发现 | `smoke:scan` 发现池并落库；时序表有行 |
| 筛选 | 精筛在真实候选上运行并给出首个合格池 |
| **建仓** | `/start` → 出现确认推送 → 确认 → **构造出待广播交易**（dry-run 不广播） |
| 监控 | 启动后 5 分钟节拍产出估值 |
| 风控 | 注入 TVL 崩塌 → 观察到自动撤池路径被触发 |
| **换池** | `/exit` → 观察到重新选池 → 构造出新的建仓交易 |
| 查询 | 8 个命令各返回真实数字，无 "not wired" |

---

## 8. 运行环境

| 项 | 值 |
|---|---|
| 技术栈 | TypeScript / Node（viem + PancakeSwap V3 SDK） |
| 链 | BNB Chain（chainId 56） |
| 存储 | SQLite |
| 配置 | `config/strategy.yaml` + 环境变量 |
| 部署 | 见 [`../OPS.md`](../OPS.md)；日常操作见 [`../USAGE.md`](../USAGE.md) |

---

## 附录 A · 不变量（实现必须保持）

> 以下每一条都是**已经验证过的判断语义**，落实在各模块中。**任何改动只允许换调用位置，不允许改变判定语义。**
> 每一条都对应基线条款；偏离即视为产品行为变更，需显式确认。

### A.1 建仓可行性判断链（"这个池子现在能不能建仓"）

这是整个产品的核心决策，**六道判断按固定顺序**，缺一不可：

| # | 判断 | 实现 | 依据 | 精华点 |
|---|---|---|---|---|
| 1 | **池身份与白名单** | `poolFilter`（`CHAIN_NOT_WHITELISTED` / `DEX_NOT_WHITELISTED` / `LEG_NOT_WHITELISTED` / `STOCK_LEG_MISSING` / `STABLECOIN_LEG_MISSING`） | §8/§11/§12/§14 | **按合约地址**判定，无 symbol 路径 |
| 2 | **§16 硬门槛** | `poolFilter`（TVL / volume / age / NAV deviation / $3500 impact） | §16 | **任一不过直接淘汰，不进入排序**；每个条件都有"恰好等于阈值"的边界测试 |
| 3 | **建仓数学** | `planPosition`（区间 → tick 对齐 → **以 USD 总量反解 L** → 三分支金额 → swap 缺口） | §33–§38 | **不是固定 50/50**；反解出的 L **绝不超募**（`valueAt(L) <= capital` 且 `L+1` 超） |
| 4 | **报价与滑点闸门** | `evaluateSwapQuote`（impact / slippage / TTL） | §40/§41 | **impact 必须本地自算**（SDK 不提供）；**报价过期即拒** |
| 5 | **分配比例** | `checkBuildAllocation`（按**结果态**判定） | §3 | 两次各自"合规"的建仓**不得合起来超比例** |
| 6 | **写路径与确认** | `TxGuardChecks` + 写目标白名单 + `ApprovalGate` | §93/§95/D2 | 伪造的全 true guard **不能**绕过写目标校验（KI-21） |

**顺序是约束，不可调换**：便宜且不可绕过的判断在前，涉及人的判断在最后 —— 否则会把"已经被拒的建仓"拿去问人。

**搬迁到模块 2 时**：第 1、2 项中**HTTP 可测的部分**留在模块 1，**链上才能测的部分**（NAV deviation、$3500 impact）移到模块 2。第 3–6 项**原样保留**，只换调用点。

### A.2 风控判定

`src/strategy/riskManager.ts`：

| 判定 | 函数 | 基线 | 精华点（易被简化掉的） |
|---|---|---|---|
| 脱锚五档 | `evaluatePegRisk` / `classifyPegLevel` | §54–§55 | 五档边界**精确**：0.01/0.02/0.03/0.05，各有"恰好等于"测试 |
| **闭市脱锚只报警** | `thresholdExpansionFor` + `hardExitAllowed` | **§56/§57** | **`hardExitAllowed === false` 时，再大的脱锚也只能告警，绝不产生强制平仓** —— 这是最容易被重构丢掉的一条 |
| 全局回撤线 | `evaluateDrawdown` | §65–§66 | 边界**含 `<=`**：NAV 恰好 = 初始×85% 即触发 |
| TVL 崩溃 | `evaluateTvlCollapse` | §59 | >50% → REVIEW，>70% → EMERGENCY；**无历史 → `insufficient-data`（fail closed），不是"安全"** |
| 储备下限 | `evaluateReserve` | §60 | <25% 阻止新增 LP，但**不强制 rebalance** |
| 区间 | `evaluateRangeRisk` | §49–§52 | 出上界=不追涨；**出下界=`RISK_REVIEW`（人工），不自动卖** |
| 紧急事件 | `evaluateEmergency` | §58 | 9 类条件逐个可触发 |
| 市场下跌 | `evaluateMarketDecline` | §53 | 股价跌 + NAV 同步跌 → **HOLD**，不是卖出 |
| **复合判决** | `evaluateRisk` | — | 取所有域中**最严动作**；`dataDegraded` 阻止把 HOLD 当清洁健康；severity 取各域**最大值**（曾修过的真实缺陷） |

**三条硬性要求**（有专门测试锁定，不得放松）：

1. **闭市 + 大幅脱锚 → 只告警，不平仓**（§57）
2. **市场同步下跌 → HOLD**（§53）
3. **数据降级 → 不得当作健康**，`dataDegraded: true` 必须让调用方无法把 HOLD 读成"没事"（§96）

**接线状态**：见 [feature-list.md](feature-list.md) §6——判定逻辑本身完整，接线状态以该表为准。

### A.3 数据可信度规则（跨模块）

| 规则 | 实现 | 为什么关键 |
|---|---|---|
| **`Sourced<T>` 三件套** | `value` + `source` + `stale` | 每个外部数字都带出处与新鲜度，消费者可据此拒绝 |
| **"不存在" ≠ "读不到"** | `POOL_EXISTENCE` / `POOL_EXISTENCE_EVIDENCE` | 数据源失败**不得**被当成"这个池子没有" —— 否则会错误地放弃或错误地建仓 |
| **不可用即拒绝** | `*_UNAVAILABLE` 系列码 + `ONCHAIN_UNVERIFIED` | §16 的 impact / deviation 读不到 → 该候选判 `indeterminate` 并跳过，**不当作通过** |
| **fees 标注为 `derived`** | `Sourced.source = 'derived'` | `volume × feeTier` 是推导值，**不得伪装成真实费用数据** |
| **两源冲突取 canonical + 留 crossCheck** | GeckoTerminal 为 canonical，DexPaprika 存 `crossChecks` | 实测两源 TVL 差约 3%；**不得静默混用** |
| **NAV 不重复计入 realized fees** | `buildPortfolioSnapshot` | 重复计会抬高 NAV、**静默关闭 §66** |
| **稳定币不假设为 1.0** | `PortfolioMonitor.stablecoinPrice` | 假设平价会**隐藏脱锚**（§58） |

### A.4 执行安全（写路径，一字不改）

| 机制 | 实现 | 精华点 |
|---|---|---|
| **唯一写路径** | `BscChainAdapter.sendTransaction` | 全系统只有这一个出口 |
| **写目标独立校验** | `assertWhitelistedWriteTarget` | 伪造的全 true guard **仍不能**指向非白名单地址（KI-21，含负向对照测试） |
| **§42 原子建仓全有或全无** | `supportsAtomicBuild` + `swapForDeficit` | 原子抛错**不得**回退成两笔（会丢 §42 语义） |
| **§43 partial 不自动重试** | `PARTIAL_POSITION` 状态 | swap 成功但 mint 失败 → 停车人工，**不自动补救** |
| **§97 幂等** | `TxStore` + `checkIdempotencyKey` | 同 key 第二次**不发交易**；确定性失败后可开 attempt N+1，未解决时拒绝 |
| **§98 UNKNOWN 不重发** | `TxStateUnknownError` + `planUnresolvedRecovery` | 未知状态**只能查链确认**，永不自动重发 |
| **provider 故障可切换端点** | `ProviderFaultError` 分类 | `-32603` 等**不得**被误报成 `execution reverted`（KI-19/KI-21） |
| **错误文本脱敏** | `redactSecrets` | 端点 URL 里的 API key **不得**进入日志 |
| **确认门 fail closed** | `ApprovalGate` + `noopNotifier` | 无通道 ⇒ 建仓/换池**不可能执行**，不降级为自动 |

### 11.5 量化与单位约定（跨模块）

| 约定 | 说明 |
|---|---|
| 金额一律 **raw bigint** + 随行 decimals | 绝不把 raw 当 UI 数量 |
| BSC USDC/USDT = **18 decimals**（不是 6） | 硬编码 6 会产生 10¹² 级错误 |
| **BEP-677 UI 换算运行期读取** | `uiMultiplier()` 绝不硬编码 1e18；实测 QQQB = 1.000724838658 |
| 价格是 **UI 计价**（token1 per 1 whole token0） | 与 `toFloat(raw, decimals)` 同口径 |
| tick 对齐用 **per-DEX** 的 fee→tickSpacing 表 | Pancake 与 Uniswap **不共享** fee 枚举，混用会静默选错池 |
| `toFloat` / `fromFloat` / `applyFloorRatio` | 唯一换算入口；`floor` 方向是签名安全方向 |

### 11.6 搬运方式（避免丢失的操作要求）

```text
允许：换调用位置、改函数签名以适配新模块、拆分为两段（HTTP 段 / 链上段）
禁止：改判定语义、删边界测试、把 hardExitAllowed 之类的"限幅"简化掉、
      把 fail-closed 分支改成 fail-open、把 §99 校验整体降级为单读
      （分级见 §5.5，且「关键」类必须保持双读）

要求：搬迁后，§7.1–§7.5 的每一项都必须仍能由现有测试证明。
      若某测试因搬迁而无法再表达，必须写等价测试，不得删除。
```

**验收方式**：重构完成后，`tests/strategy/riskManager.test.ts`（78）、`positionPlanner.test.ts`（36）、`swapPlanner.test.ts`（31）、`allocation.test.ts`（24）、`positionExecutor.test.ts`（26）等**必须全绿且断言未被削弱**。测试通过不是形式 —— 它是这些精华唯一的凭证。

---

---

## 9. 相关文档

| 想了解 | 读 |
|---|---|
| 每条功能的实现状态 | [`feature-list.md`](feature-list.md) |
| 待开发项与顺序 | [`../plan/development-plan.md`](../plan/development-plan.md) |
| 部署与运维 | [`../OPS.md`](../OPS.md) |
| 日常操作 | [`../USAGE.md`](../USAGE.md) |
| 已知问题 | [`../known-issues.md`](../known-issues.md) |
| 技术决策记录 | [`../decisions/`](../decisions/) |
| 规则条款细节 | [`stock-lp-auto-strategy-v1.md`](stock-lp-auto-strategy-v1.md)（参考，非权威） |
