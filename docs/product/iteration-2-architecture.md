# Iteration 2 架构：池子发现、筛选与持仓监控

**状态**：**已确认**（用户 2026-09-30）
**取代/修订**：本文件修订 Iteration 1 的若干实现安排（不改产品语义，除 §6 的范围问题 —— 已裁定推迟）
**基线**：`docs/product/stock-lp-auto-strategy-v1.md`

> 本文件只描述**模块职责、数据契约、节奏与存储**。产品行为（阈值、风控等级、换池门槛）以基线为准，本文件不重新定义；凡与基线冲突之处，在 §6 单列说明（模块 4 已确认推迟）。

---

## 1. 为什么要重梳

Iteration 1 把「池子发现」与「链上精读」混在一个 `PoolScanner` 里，导致：

| 问题 | 实测/证据 |
|---|---|
| 每轮扫描对**全部候选组合**做链上 `factory.getPool()` 探测 | `enumerateCandidatePairs` = 5 股票 × 2 稳定币 × 2 DEX = 20 组合，再乘 fee tiers |
| 组合监控对**全部 11 个白名单 token** 做 `uiMultiplier` 探测 | 11 × 3 次调用 = 33 次，且**探测缓存 TTL(5min) = 监控间隔(5min)**，每轮必然错过缓存 |
| §99 交叉校验让每个请求发 **2 遍** | 首轮 `readWallet` ≈ 72 次 HTTP |
| 池子**时序数据不落库** | 于是「TVL 24h 骤减」这个风控**永远算不出**（需要两个时间点） |
| 风控逻辑**未被调度** | `tvlSeries` / `position` 在 `runtime.ts` 中零引用；`pool_health_interval_minutes` 未注册 |

**结论**：不是"多花了一点请求"，而是**低成本层与高成本层没有分开**，且**风控判据缺数据源**。

---

## 2. 四模块划分

```text
┌─ 模块 1 · PoolScanner ──────────────────────────────── 纯 HTTP，无链上 ─┐
│  输入：股票代币白名单                                                  │
│  输出：该股票的所有 USDT/USDC 池 + 基础信息，落库                        │
│  节奏：每 pool_scan_interval_minutes（默认 60）                         │
└────────────────────────────────────────────────────────────────────┘
                                  │ 候选池列表（按 APR 排序）
                                  ▼
┌─ 模块 2 · 逐池精筛（PoolScreener）──────────────────── 链上，串行短路 ──┐
│  输入：候选池列表                                                      │
│  输出：首个通过全部门槛的池 → 进入建仓                                  │
│  节奏：仅在准备建仓时运行（非周期）                                     │
│  关键：**首个合格即停止**，不遍历全部候选                               │
└────────────────────────────────────────────────────────────────────┘
                                  │ 选定的一个池
                                  ▼
┌─ 模块 3 · 持仓监控（PositionMonitor）───────────────── 链上，高频 ─────┐
│  输入：当前持仓的池 + 仓位                                             │
│  输出：实时权益、区间位置、未领手续费、脱锚、风控判定                     │
│  节奏：每 portfolio_interval_minutes（默认 5）+ 池健康 15min             │
└────────────────────────────────────────────────────────────────────┘
                                  │ 风控触发
                                  ▼
┌─ 模块 4 · 换池（SwitchManager）─────────────────────── 链上，事件驱动 ─┐
│  撤池 → 重新回到模块 2 找新池 → 建仓 → 回到模块 3                        │
│  ⚠ 属基线 Phase 5，Iteration 1 已裁剪 —— 见 §6                            │
└────────────────────────────────────────────────────────────────────┘
```

**分层原则**：模块 1/2 是**筛选层**（便宜、可失败、可缓存）；模块 3/4 是**执行层**（贵、必须成功、涉及资金）。两者不共享代码路径，失败语义也不同。

---

## 3. 模块 1 · PoolScanner（纯 HTTP）

### 3.1 职责

**只做两件事**：发现池子、记录基础信息。**不做任何链上调用。**

### 3.2 数据来源

| 字段 | 来源 | 说明 |
|---|---|---|
| 池地址 / DEX / feeTier | GeckoTerminal `/tokens/{addr}/pools` | 权威发现 |
| TVL | GeckoTerminal `reserve_in_usd` | canonical |
| volume 24h | GeckoTerminal | |
| volume 7d | DexPaprika `volume_usd_7d` | GT 无此字段 |
| pool age / createdAt | GeckoTerminal `pool_created_at` | |
| **APR 24h / 7d** | **本地计算**，见 §3.4 | **禁止用前端 APR**（基线 §17） |

**冲突策略**：两源不一致时**取 GeckoTerminal 为 canonical**，另一值存入 `crossChecks` 供审计（实测两源 TVL 差约 3%）。**不得静默混用**。

### 3.3 缓存与落库

**两层**：

```text
① 短期缓存（内存）：同一轮内避免重复请求同一 token/池
② 长期落库（SQLite）：每次采样写一行，形成时间序列
```

**落库表**（新增）：

```sql
CREATE TABLE pool_snapshots (
  id            INTEGER PRIMARY KEY,
  pool_id       TEXT NOT NULL,          -- §13: chainId:dex:poolAddress
  sampled_at    TEXT NOT NULL,          -- ISO
  tvl_usd       REAL,
  volume_24h    REAL,
  volume_7d     REAL,
  apr_24h       REAL,                   -- 本地计算
  apr_7d        REAL,                   -- 本地计算
  pool_age_days REAL,
  source        TEXT NOT NULL,          -- 'geckoterminal' | 'dexpaprika' | ...
  stale         INTEGER NOT NULL        -- 0/1，数据源降级时必须记录
);
CREATE INDEX idx_pool_snapshots_lookup ON pool_snapshots(pool_id, sampled_at);
```

**为什么必须落库**：聚合 API **只给当前值**，不给"24 小时前的 TVL"。基线 §59 的「TVL 24h 跌幅 > 50%」需要**两个时间点** —— 只能靠自采样。**没有这张表，该风控永远无法触发。**

**保留策略**：至少 30 天（覆盖 7d/30d 变化率与 §90 周报）。

### 3.4 APR 计算（本地，基线 §17–§18）

```text
FeeAPR_d = (fees_d / avgTVL_d) × (365 / d)

其中 fees_7d  由 volume_7d × feeTier 推导（免费 API 不直供 fees）
     fees_24h 同理
```

**必须在数据上标注为 `derived`**（`Sourced<T>.source = 'derived'`），不得伪装成真实数据 —— 这是 §96 与 Iteration 1 已确立的规则。

### 3.5 失败语义

| 情况 | 行为 |
|---|---|
| 某字段拿不到 | 标 `stale: true` + `source: 'unavailable'`，**照常落库**（缺失本身是信息） |
| 整个数据源失败 | 该轮记为失败，**不产出候选列表**，告警一次；**绝不当成"没有池子"** |
| 429 限流 | 退避重试（已有实现，6 秒最小间隔 + 指数退避） |

**关键区分**（Iteration 1 已实现，保留）：**「池子不存在」≠「读不到」**。前者是 `absent`（有链上 factory 零地址或 HTTP 明确无结果），后者是 `unverified`。

### 3.6 输出契约

```typescript
interface PoolCandidate {
  readonly poolId: PoolId;              // §13 身份
  readonly dex: DexId;
  readonly feeTier: FeeTier;
  readonly token0: Address;             // 含股票腿与稳定币腿的地址
  readonly token1: Address;
  readonly tvlUsd: Sourced<number>;
  readonly volume24h: Sourced<number>;
  readonly volume7d: Sourced<number>;
  readonly apr24h: Sourced<number>;     // derived
  readonly apr7d: Sourced<number>;      // derived
  readonly poolAgeDays: number;
  /** HTTP 层能判定的硬门槛结论，链上项留 pending */
  readonly prefilterVerdict: 'pass' | 'reject' | 'indeterminate';
  readonly prefilterReasons: readonly string[];
}
```

---

## 4. 模块 2 · 逐池精筛（PoolScreener）

### 4.1 职责

从候选列表里**找出第一个可建仓的池**，然后**立即停止**。

**核心约束：串行 + 短路。** 不遍历全部候选（那是浪费 —— 只需要一个池）。

### 4.2 两段式过滤（关键设计）

基线 §16 有 5 项硬门槛，但**它们的数据来源不同**：

| §16 门槛 | 数据来源 | 在哪一段测 |
|---|---|---|
| 白名单（chain/DEX/token 地址） | 配置 | **模块 1**（无需请求） |
| `TVL >= 500k` | HTTP | **模块 1** |
| `7D 均日量 >= 250k` | HTTP | **模块 1** |
| `pool age >= 7d` | HTTP | **模块 1** |
| **`NAV deviation < 1%`** | **链上价格 + 参考价** | **模块 2** |
| **`$3500 impact < 0.5%`** | **QuoterV2** | **模块 2** |

```text
模块 1（HTTP）：用能测的 3 项剔除大部分候选 → 得到"待精筛列表"
模块 2（链上）：对每个候选依次测 2 项链上门槛 + 建仓数学
              ├─ 全部通过 → 建仓，停止
              └─ 任一不过 → 下一个候选
```

**为什么这样分**：`impact` 是小池子最容易挂的一项（Iteration 1 实测：Uniswap 的 QQQB/USDC 池 TVL/volume 达标，但因 `$3500 impact = 0.66% > 0.5%` 被淘汰）。若在模块 1 就尝试测 impact，等于对全部候选上链 —— 正是本次要消除的开销。

### 4.3 排序

**候选先按 `apr7d` 从高到低**（基线 §22 要求看 7d/30d，不能只看 1d）。

⚠ **已知张力**：APR 最高的池往往流动性最差（小池子 fee 高）。缓解是**模块 1 已剔除 TVL/volume/age 不合格者**，所以排序时剩下的都是"够大"的池。**但仍建议**：先按 `apr7d` 排序，再按 `tvlUsd` 做**次级**排序，避免在同等 APR 时优先选更薄的池。

**已确认**（§8.2）：先用 `apr7d` 主序 + `tvlUsd` 次序；时序数据满足条件后升级为基线 §21 的完整五分量池分（升级触发条件见 §8.2）。

### 4.4 每个候选的精筛步骤

```text
1. 链上读池状态：slot0（tick/price）、liquidity、feeTier、tickSpacing
2. 校验池身份与模块 1 的记录一致（token0/token1/fee 与候选一致）
   ——不一致视为"聚合站数据过期或错误"，跳过该候选并记日志
3. 读参考价 → 算 tokenNAVDeviation → 判 §16 的 1% 门槛
4. 用 QuoterV2 对"预算单量"报价 → 算 priceImpact → 判 §16 的 0.5% 门槛
5. 计算建仓数学：区间（§33）、tick 对齐（§34）、最优比例（§36–§37）
6. 全部通过 → 交给建仓流程（模块 3 的入口）
```

### 4.5 失败与终止

| 情况 | 行为 |
|---|---|
| 某候选不合格 | 记录原因（供 §77 决策日志），取下一个 |
| 候选耗尽 | **本轮不建仓**，告警一次「本轮无合格池」，等下一轮扫描 |
| 发现有 >1 个未平仓位 | **停机告警**（§8.5 单池硬约束），不继续选池 |
| 链上读取失败（provider 故障） | 按 Iteration 1 的修复：**视为 transport 故障，切换端点**；两个端点都失败则该轮放弃（不跳过该候选继续测下一个 —— 因为无法区分"该池不行"与"读不到"） |
| 数据源降级（`stale`） | **该候选判 `indeterminate`，跳过**（§96：无法验证即不通过） |

⚠ **最后一条很重要**：`impact` 或 `deviation` 读不到时**不能当作通过**。Iteration 1 的 `POOL_FILTER_CODES` 已有 `*_UNAVAILABLE` 系列码，予以保留。

### 4.6 是否需要上限

若有 20 个候选且全部不合格，最坏是 20 次链上精筛。**建议不设硬上限**，理由：
- 模块 2 **只在准备建仓时运行**（不是周期任务）
- 模块 1 已剔除大部分
- 设上限会漏掉后面的合格池

但**必须记录耗时**，若某轮精筛超过预期（如 > 2 分钟），告警提示数据源或 RPC 异常。

---

## 5. 模块 3 · 持仓监控（PositionMonitor）

### 5.1 与模块 1/2 的本质区别

| | 模块 1/2 | 模块 3 |
|---|---|---|
| 对象 | 市场（很多池） | **自己的仓位（一个池）** |
| 失败容忍 | 高（可以跳过候选） | **低**（读不到就该停手，不能瞎猜） |
| 链上频率 | 低 | 高（5min / 15min） |
| 涉及资金 | 否 | **是** |

### 5.2 监控内容（基线 §46）

```text
钱包余额（当前持仓的 2 个 token + native）
LP 仓位价值（amount0/amount1 由 liquidity + 当前 tick 反算）
未领手续费（tokensOwed0/1）
当前 tick / 区间位置（RangeProgress，§49）
脱锚偏差（链上价 vs 参考价，§54）
池 TVL 与流动性（§59，用模块 1 的时序 + 本次链上值）
储备比例（§60）
组合 NAV 与回撤（§65–§66）
```

### 5.3 优化：只读持仓相关的 token

**当前问题**：`readWallet` 对全部 11 个白名单 token 做探测与余额批读。

**改为**：

```text
必读（每轮）：持仓的股票代币 + 稳定币 + native
        —— 这 2 个 token 决定全部 NAV 计算
可选（低频）：其余白名单 token
        —— 仅在"检查是否有其他资产"时读（如 每小时一次，或建仓前一次）
```

**理由**：NAV 的正确性只依赖**你实际持有的资产**；没持有时，其乘数算错也不影响任何数字。

**风险**：若有资产转到钱包但不在"持仓 token"里，会被漏算。**缓解**：低频全量扫一次作为兜底（建议每 60 分钟或每次组合监控的每 N 轮）。

**已确认**（§8.3）：只读持仓 token + 60 分钟全量兜底；漏算方向为保守（NAV 偏低 → §66 更早触发），用户接受此推论。

### 5.4 探针缓存 TTL

**当前**：`TokenReader.cacheTtlMs` 默认 **5 分钟**，**恰好等于监控间隔** → 每轮都错过缓存。

**改为**：

| token 类别 | TTL | 理由 |
|---|---|---|
| 持仓的 token | **每个监控轮次重新读**（或 30s） | 其 `uiMultiplier` 直接影响 NAV |
| 非持仓的 token | **24 小时** | 不影响任何计算；企业行动有 `effectiveAt` 提前公告 |
| 稳定币（无 BEP-677） | 永久（探测一次即可，结果不会变） | 实测 USDC/USDT 不支持 scaled UI amount |

**实现方式**：`probeUiAmount` 增加一个"关键性"参数，或按 token 是否在持仓集合里决定 TTL。

**已确认**（§8.3）：只读持仓 token + 60 分钟全量兜底。兜底扫描同时刷新非持仓 token 的探针缓存。

### 5.5 §99 交叉校验分级

**当前**：所有 `readContract` 都双端点校验 → 请求 ×2。

**已确认决策（§8.4）：保持全量双读，不做分级。** 理由记录如下 —— 原"分级可省一半请求"的估算基于全量读取（11 token）；按 §8.3 改造后每轮只读 2 个 token + 1 个池，省下的绝对值很小，而削弱的是一致性保护，收益不足以承担风险。

以下分级方案**仅作为未来可选优化存档**，当前不实施：

| 类别 | 例子 | 校验 |
|---|---|---|
| **关键**（读错立刻亏钱） | `slot0`、`liquidity`、报价、`tickSpacing` | **双读** |
| **自愈**（下一轮会纠正） | 余额、`tokensOwed`、`uiMultiplier` | **单读** + 周期性双读抽查 |
| **元数据** | `token0`/`token1`/`decimals`/`supportsInterface` | **单读并长期缓存** |

**理由**：余额读错一次，下一轮就修正，不会导致错误交易；而 `tick` 读错会让区间与比例算错，是即时损失。

（**不实施** —— 见上。真正省请求的是 §8.3 与 §5.4。）

---

## 6. 模块 4 · 换池（**已确认推迟到 Iteration 3**）

**已确认决策（§8.1）：Iteration 2 不做本模块。** 本章保留为设计备忘 —— Iteration 3 开始时以此为基础。

**推迟理由（决定性的一条）**：本模块消费模块 3 的风控判定，而模块 3 目前未接线。先做本模块等于用一套从未真实运行过的判据驱动会自动撤池的逻辑 —— 行为异常时无法区分"风控判错"还是"换池逻辑错"。退出条件见 §8.1。

### 6.1 触发条件（按基线，不由本文件重新定义）

| 触发 | 基线依据 | 处置 |
|---|---|---|
| `FeeILRatio < 1`（收益覆盖不了无常损失） | §7 | 进入 `UNDERPERFORMING` |
| `7D Net APR < 12%` 持续 72h | §28–§29 | 进入 `SEARCH_REPLACEMENT` |
| TVL 24h 跌 > 50% | §59 | `RISK_REVIEW` |
| TVL 24h 跌 > 70% | §59 | `EMERGENCY` |
| 脱锚 > 3% | §55 | `EXIT_REVIEW` |
| 脱锚 > 5% | §55 | `EMERGENCY_EXIT` |
| 全局 NAV ≤ 初始 × 85% | §66 | `GLOBAL_RISK_OFF` |
| **价格出下界** | §51 | ⚠ **`RISK_REVIEW`（人工）** —— 基线明确「不自动卖」 |

### 6.2 换池门槛（基线 §29–§32，必须全部满足）

```text
新池净 APR >= 当前净 APR + 8 个百分点
BreakEvenDays <= 14
换池成本 <= 资本 × 0.75%
冷却期已过（成功换池后 7 天）
新池池分 > 当前池分
```

**风控事件豁免冷却期**（§32 明文列举：脱锚、合约风险、发行方风险、TVL 崩溃、流动性消失）。

### 6.3 状态机

```text
MONITOR
  ├─ 正常 → MONITOR
  ├─ 收益不足（持续 72h）→ UNDERPERFORMING → SEARCH_REPLACEMENT
  │                                            ├─ 找到更好的池 → SWITCH_POOL → MONITOR
  │                                            └─ 没有 → MONITOR
  └─ 风控事件 → RISK_REVIEW
                  ├─ 正常（市场同步下跌，§53）→ MONITOR
                  └─ 严重 → EXIT_POSITION → PAUSED
```

**注意**：撤池 ≠ 自动卖币。基线 §67 明确「不一定自动卖掉所有股票 Token；是否卖出由 RISK_REVIEW 决定」。

### 6.4 撤池后的资金去向

撤池得到的是**股票代币 + 稳定币**。回到模块 2 找新池时：
- 若新池是同一股票 → 可直接建仓
- 若换股票 → 需要 swap，**先评估成本**（§30 的 Switching Cost）

---

---

## 7. Iteration 1 精华保留清单（重构不得丢失）

> **本节是本文件最重要的一节。** 重梳模块划分时，最容易发生的损失不是"写错新代码"，而是**把已经验证过的判断逻辑在搬迁中丢掉或简化**。以下每一项都在 Iteration 1 已实现且有测试覆盖（727 测试 / 25 文件）。**改动时只允许换调用位置，不允许改变判定语义。**

### 11.1 建仓可行性判断链（"这个池子现在能不能建仓"）

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

### 11.2 风控判定（已实现，**当前未接线**）

`src/strategy/riskManager.ts` 是 Iteration 1 最完整的一块（**78 个测试**）。**搬迁到模块 3 时全部保留**：

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

**三条硬性要求**（有专门测试锁定，搬迁时不得放松）：

1. **闭市 + 大幅脱锚 → 只告警，不平仓**（§57）
2. **市场同步下跌 → HOLD**（§53）
3. **数据降级 → 不得当作健康**，`dataDegraded: true` 必须让调用方无法把 HOLD 读成"没事"（§96）

**当前缺口**：`runtime.ts` **没有调用** `evaluateRisk`，且不喂 `tvlSeries` / `position` / `pool`。**模块 3 的核心工作就是把这块接上**，而不是重写。

### 11.3 数据可信度规则（跨模块，必须保留）

| 规则 | 实现 | 为什么关键 |
|---|---|---|
| **`Sourced<T>` 三件套** | `value` + `source` + `stale` | 每个外部数字都带出处与新鲜度，消费者可据此拒绝 |
| **"不存在" ≠ "读不到"** | `POOL_EXISTENCE` / `POOL_EXISTENCE_EVIDENCE` | 数据源失败**不得**被当成"这个池子没有" —— 否则会错误地放弃或错误地建仓 |
| **不可用即拒绝** | `*_UNAVAILABLE` 系列码 + `ONCHAIN_UNVERIFIED` | §16 的 impact / deviation 读不到 → 该候选判 `indeterminate` 并跳过，**不当作通过** |
| **fees 标注为 `derived`** | `Sourced.source = 'derived'` | `volume × feeTier` 是推导值，**不得伪装成真实费用数据** |
| **两源冲突取 canonical + 留 crossCheck** | GeckoTerminal 为 canonical，DexPaprika 存 `crossChecks` | 实测两源 TVL 差约 3%；**不得静默混用** |
| **NAV 不重复计入 realized fees** | `buildPortfolioSnapshot` | 重复计会抬高 NAV、**静默关闭 §66** |
| **稳定币不假设为 1.0** | `PortfolioMonitor.stablecoinPrice` | 假设平价会**隐藏脱锚**（§58） |

### 11.4 执行安全（写路径，一字不改）

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

## 8. 已确认决策

> 用户 2026-09-30 确认。**本节是权威结论**，取代原先的"待确认清单"。

### 8.1 模块 4（自动换池）：**本次不做，推迟到 Iteration 3**

**决定**：Iteration 2 只做模块 1–3。模块 4 待模块 3 稳定运行后再做。

**依据**：
- 基线 §109 的节奏本来就是 Phase 3（单池实盘）在 Phase 5（自动换池）**之前**。D1 裁剪 Phase 5 时隐含假设即"Phase 3 先跑通" —— 所以这不是新增保守，而是回到原节奏。
- **技术上的决定性理由**：模块 4 消费模块 3 的风控判定，而模块 3 **目前未接线**（`runtime.ts` 中 `tvlSeries`/`position` 零引用，`evaluateRisk` 从未被调用）。先做 4 等于**用一套从未真实运行过的判据去驱动会自动撤池的逻辑** —— 一旦行为异常，无法区分是"风控判错"还是"换池逻辑错"。

**退出条件**（满足后方可进入 Iteration 3）：
```text
模块 3 的 evaluateRisk 已接线并连续运行，且：
  · TVL 时序表已积累 >= 7 天数据（否则 §59 判据仍是 insufficient-data）
  · 至少经历一次完整的"建仓 → 监控 → 退出"闭环
  · 决策日志可回答"某天为什么做了某个动作"
```

### 8.2 候选排序：**`apr7d` 主序 + `tvlUsd` 次序**（分级实施）

**决定**：现在用两级排序；时序数据足够后升级为基线 §21 的完整综合池分。

**依据**：§21–§26 定义的池分含 `VolumeStability`(15%) 与 `AssetStability`(15%)，**两者都需要历史序列**（volume 的标准差/变异系数、波动率），而 §3.3 的时序表刚建立、尚无足够历史。§22 明确"不能单独使用 1D APR" —— 用 7d 而非 1d 已满足该要求。

**升级触发条件（写死，避免变成"永远不做"）**：
```text
pool_snapshots 覆盖 >= 4 周 且 每池有效样本 >= 200 时
→ 实现 §21 五分量加权池分，替换两级排序
```
**在升级前**：决策日志中必须记录"当前排序为 apr7d+tvlUsd，非综合池分"，使判据可审计（§77）。

### 8.3 模块 3 只读持仓 token：**是，并加低频全量兜底**

**决定**：每轮只读持仓的 2 个 token + native；另有**每 60 分钟一次的全白名单扫描**作为兜底。

**依据与风险**：
- NAV 的正确性只依赖**实际持有的资产**；未持有时其 `uiMultiplier` 算错不影响任何数字。
- **遗留风险**：若有人手动往钱包转入白名单内的其他 bStock，最多 **60 分钟**内不会被计入 NAV。
- **方向上是安全的**：漏算使 NAV **偏低** → §66 回撤线**更早触发** → 保守方向的**误报**，不是危险的漏报。用户接受此推论。

**当前实现缺陷（须修）**：`TokenReader.cacheTtlMs` 默认 **5 分钟 = 监控间隔**，导致**每轮必然错过缓存**，从未真正命中过。

### 8.4 §99 交叉校验：**保持全量双读**（撤回原"分级"建议）

**决定**：不改。所有 `readContract` 继续双端点校验。

**依据（修正此前的判断）**：原建议"分级可省约一半请求"是**按全量读取（11 token）估算的**。按 §8.3 改造后，模块 3 每轮实际只读 **2 个 token + 1 个池**，请求量本已很小 → **分级能省的绝对值很小，而削弱的是一致性保护**。收益不足以承担风险。

**结论**：真正省请求的是 §8.3（只读持仓）与 §5.4（探针 TTL），**不是校验分级**。

### 8.5 单池：**硬约束 —— 检测到多持仓即停机告警**

**决定**：硬约束。发现超过 1 个未平仓位 → 立即停机 + 告警，**不静默处理**。

**依据（代码事实）**：`StateStore` 的 `positions` 表已有
```sql
UNIQUE INDEX ... WHERE closed_at IS NULL ON (chain_id, pool_address)
```
即**数据库层已强制单池**。因此多持仓在正常路径下**不可能出现**，出现只有两种原因：
1. **人工干预**（在前端手动建了仓位）
2. **程序 bug**（幂等或状态机出错）

**两种情况都必须停下来问用户**。静默"取第一个、忽略其余"会把 bug 掩盖成正常运行 —— 这是本决定的核心。

**停机时必须报出所有发现的仓位**（tokenId、池、金额），使人工可判断。

### 8.6 出下界：**按基线转人工复核，不自动撤池** ⚠ 最重要

**决定**：`price <= lower` → `RISK_REVIEW`（人工），**绝不自动撤池**。

**依据（基线明文）**：
- §51：`Price <= Lower` → `RISK_REVIEW`（不是 EXIT）
- §52：下界须检查"标的股票是否同步下跌"
- §53：**股价跌 + NAV 同步跌 → `MARKET_RISK`，默认 `HOLD`**

**为什么这条最关键**：价格出下界意味着**仓位已几乎全部变为股票代币**。此时自动撤池等于：

```text
在市场低点卖出
+ 把浮亏变成实亏
+ 且很可能正卖在底部
```

而"股价跌 + NAV 同步跌"是**市场风险**（§53），不是策略失败 —— 基线把它归为人工复核是**刻意设计**，不是遗漏。

**告警必须带足上下文**（否则用户无法在 Telegram 上判断）：
```text
当前价 / 下界价 / 偏离幅度
标的股价变动 % 与参考 NAV 变动 %（判断是否同步下跌）
脱锚偏差（判断是否 token 问题而非市场问题）
池 TVL 与流动性变化
```

### 8.7 决策汇总表

| # | 议题 | 决定 | 性质 |
|---|---|---|---|
| 1 | 模块 4 自动换池 | **推迟到 Iteration 3**，附退出条件 | 范围 |
| 2 | 候选排序 | `apr7d` + `tvlUsd`，时序够后升 §21 综合分 | 技术（含升级条件） |
| 3 | 只读持仓 token | 是 + 60 分钟全量兜底 | 安全权衡（用户接受保守误报） |
| 4 | §99 校验 | **保持全量双读**（撤回原建议） | 安全 |
| 5 | 单池 | **硬约束**，多持仓停机告警 | 产品 |
| 6 | 出下界 | **转人工，不自动撤** | 产品（最重要） |

---

## 9. 对现有实现的改动清单

| 模块 | 改动 | 影响面 |
|---|---|---|
| 模块 1 | **移除** `PoolScanner` 的链上 `factory.getPool()` 探测路径 | `src/data/poolScanner.ts`、`bscOnchainSource.findPool` |
| 模块 1 | 新增 `pool_snapshots` 表与写入 | `src/store/**`（新迁移） |
| 模块 1 | 新增本地 APR 计算 + `derived` 标注 | `src/data/**` |
| 模块 2 | **新增** `PoolScreener`（串行精筛 + 短路） | 新文件 |
| 模块 2 | 现有 `poolFilter` 拆为「宽筛（HTTP 项）」与「精筛（链上项）」 | `src/data/poolFilter.ts` |
| 模块 3 | **接线**：`runtime` 喂真实 `position`/`pool`/`tvlSeries` 给 `evaluateRisk` | `src/runtime.ts`、`src/execution/portfolioMonitor.ts` |
| 模块 3 | 注册缺失的 `pool_health_interval_minutes` cadence | `src/runtime.ts` |
| 模块 3 | 探针 TTL 分级 + 只读持仓 token | `src/chain/tokenReader.ts`、`portfolioMonitor.ts` |
| 模块 3 | §99 交叉校验分级 | `src/chain/adapter.ts`、`src/chain/rpc.ts` |
| 模块 4 | **本次不做**（§8.1，推迟到 Iteration 3） | — |

### 9.1 改动时的硬性约束

```text
每一项改动都必须满足：§7 的精华清单逐条不丢。

具体到最容易出事的四处：
  · 模块 1 移除链上探测时，不得连带删掉「不存在 vs 读不到」的区分
  · 模块 2 拆两段过滤时，不得把 §16 的任何一项降级为"可选"或"尽力而为"
  · 模块 3 接线时，是"调用已有的 evaluateRisk"，不是"重写一套风控"
  · §5.5 的校验分级只允许把「自愈类」降为单读；「关键类」（tick/liquidity/报价）必须保持双读
```

---

## 10. 不变量（本次梳理不改变的部分）

以下来自 Iteration 1，**继续保持**：

- **地址即身份**：token 只按合约地址识别，无 symbol 解析路径
- **池身份 = `chainId:dex:poolAddress`**（§13）
- **Fail closed**：未知/不可读 → 不动作，不猜
- **禁止前端 APR**（§17）、**禁固定 50/50**（§35）、**NAV ≠ 钱包余额**（§5）
- **写路径唯一**：`sendTransaction` 是唯一出口，且先过 guard + 写目标白名单（KI-21 已修）
- **确认门**：建仓/换池需人工确认（D2），无通道时不可能执行
- **provider 故障按 transport 类处理并可切换端点**（KI-19/KI-21 修复）
- **错误文本脱敏**（凭据不入日志）

---

## 11. 实施顺序（已确认）

按模块 1 → 2 → 3 执行，每步完成即跑全量测试验证 §7 的精华清单未丢。

```text
Step 1 · 模块 1（PoolScanner 纯 HTTP 化 + 时序落库）
  · 移除 PoolScanner 的链上 factory 探测路径
  · 新增 pool_snapshots 表（迁移）
  · 本地 APR 计算 + derived 标注
  · 验证：这些改动不得让「不存在 vs 读不到」的区分失效（§7.3）

Step 2 · 模块 2（PoolScreener 串行精筛）
  · 现有 poolFilter 拆为 HTTP 段与链上段
  · 新增串行短路精筛
  · 候选排序按 §8.2
  · 验证：§16 五项无一降级；fail-closed 分支保持不变（§7.1）

Step 3 · 模块 3（接线，不重写）
  · runtime 喂真实 position/pool/tvlSeries 给 evaluateRisk
  · 注册 pool_health_interval_minutes cadence
  · 探针 TTL 分级 + 只读持仓 token + 60min 兜底（§8.3）
  · 单池硬约束断言（§8.5）
  · 出下界转人工 + 丰富告警上下文（§8.6）
  · 验证：§7.2 的三条硬性要求（闭市只报警 / 同步下跌 HOLD / 降级非健康）仍成立

Step 4 · 全量回归
  · 727 测试全绿且断言未被削弱
  · 链上只读冒烟 + dry-run 建仓跑通
  · 连续运行观察一轮完整周期

Iteration 3（不在本次范围）
  · 模块 4 自动换池（退出条件见 §8.1）
  · §21 综合池分（触发条件见 §8.2）
```

**本轮不写代码直到本文件被确认** —— 现已确认，可以开始 Step 1。
