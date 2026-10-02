# 开发计划

**目标**：把产品从「能看见」推进到「能动作」，直到闭环成立。
**产品定义**：[`../product/lptrader-product.md`](../product/lptrader-product.md)
**功能现状**：[`../product/feature-list.md`](../product/feature-list.md)

---

## 验收标准（统一，适用于本计划每一条）

```text
一条功能算完成，当且仅当：

  在【真实入口】（npm run dev）下走完该功能的完整路径，
  并观察到「待广播交易已构造」或「明确的拒绝原因」。

dry-run 即为此标准：构造交易 → 编码 → 估算 gas → 到此为止。
（不签名、不广播、不花钱）

不构成完成：
  ✗ 函数存在     ✗ 单元测试通过
  ✗ typecheck 0  ✗ dry-run 单独脚本算出数字
```

**特别说明**：现有 `scripts/dry-run-build.ts` **在脚本内自己拼装组件**，绕过 `runtime.ts`。
它验证的是「这些组件能连起来」，不是「**运行时把它们连起来了**」。
因此 T2 必须补一条：**经运行时**的建仓路径。

---

## P0 · 建仓（产品能不能开始）

> 没有它，产品无法开始一笔交易。这是当前最严重的缺口。

### T1 · 精筛接入运行时

| 项 | 内容 |
|---|---|
| **现状** | `PoolScreener.screen()` 存在，`grep "\.screen(" src/` **为空** |
| **做什么** | 在运行时「准备建仓」的路径上调用精筛，取 `outcome.accepted` |
| **触及** | `src/runtime.ts`、`src/data/poolScreener.ts`（构造 screener，注入 adapters） |
| **必须处理** | `outcome.aborted === true` → **不得**当成「无合格池」（provider 故障 ≠ 池不合格） |
| **验收** | 真实候选上运行 → 日志/推送给出「首个合格池」或「全部不合格 + 逐条理由」 |
| **依赖** | 无 |

### T2 · 建仓链接入运行时（经 `runtime`，非独立脚本）

| 项 | 内容 |
|---|---|
| **现状** | `PositionExecutor.buildPosition()` 存在，生产调用点 **0** |
| **做什么** | 精筛结果 → `planPosition` → 报价 → 门禁 → **构造交易** |
| **触及** | `src/runtime.ts`、`src/execution/positionExecutor.ts` |
| **验收** | 经运行时：给定合格池 → 走到「待广播交易已构造」，输出编码与 gas，不广播 |
| **依赖** | T1 |
| **风险** | §42 原子性已弃用（D3.7，2026-10-02）：两个 DEX 统一走两笔；T2 的"原子 vs 两笔"分叉在 T5 落地时移除 |

### T3 · 建仓确认门接入

| 项 | 内容 |
|---|---|
| **现状** | `approveRebuild` 接口存在，**生产零调用** |
| **做什么** | 构造交易前推送 Approve/Reject，按审批配置等待/超时 |
| **触及** | `src/runtime.ts`、`src/execution/actionHandlers.ts`、`src/notify/telegram.ts` |
| **验收** | dry-run 下：推送请求 → 确认 → 继续构造；拒绝 → 中止；超时 → 中止并告警 |
| **依赖** | T2 |

### T4 · `/start` 真实建仓

| 项 | 内容 |
|---|---|
| **现状** | `actionHandlers.ts:164` 只返回文案 |
| **做什么** | `/start` 调用 T1→T2→T3 的**同一条**路径（不另写一套） |
| **触及** | `src/execution/actionHandlers.ts`、`src/runtime.ts` |
| **验收** | IDLE 发 `/start` → 确认推送 → 确认 → **构造出待广播交易**；无合格池 → 保持 IDLE + 告警说明原因 |
| **依赖** | T3 |

---

## P0.5 · 实盘建仓（T1–T4 完成 ≠ 能建仓）

> **T1–T4 的验收是「构造出交易」，不是「交易成功」。** 2026-10-01 首次真金实盘证明这中间隔着四类缺陷，全部无法被 dry-run 或单元测试发现。以下四条才是产品真正的 P0。

### T5 · 建池按实际余额（§5.3.3）—— ✅ **已完成（2026-10-02，双 DEX 实盘）**

| 项 | 内容 |
|---|---|
| **现状** | 建池用 `planPosition` 的计划值 → 要求 swap 恰好按报价成交 |
| **实证** | 2026-10-01 实盘三次，全部 `execution reverted: Price slippage check` |
| **做什么** | swap 落块后**重新读钱包余额**，用读回的金额建池；计划值只用于决定 swap 数量 |
| **触及** | `src/execution/positionExecutor.ts`（`runTwoStepBuild` 成为唯一路径）、`src/dex/pancakeV3.ts`（移除 `#atomicSwapAndAdd` 编码支路） |
| **必须处理** | 建池金额须 ≤ 钱包实际余额；`amount0Min/1Min` 按实际值算，不按计划值；**`runAtomicBuild` 连同 `AddLiquidityRequest.swapForDeficit` 一并移除**（§5.4：禁止原子建仓，它与 §5.3.3 不可兼得） |
| **验收** | **实盘全流程，两个 DEX 各一遍**：swap 落块 → 读回余额 → 建池成功（无 `Price slippage check`）。**2026-10-02 已通过**：PancakeSwap QQQB/USDT 0.01%（原选 AAPLB 池 TVL $492k 未过 §16，改用 $1.07M 合格池，正常）；Uniswap AAPLB/USDT 0.05%（§16 门票用 config-test 降低，偏差已记录）。证据：`docs/research/evidence-live-build-{pancake,uniswap}-20261002.txt` |
| **依赖** | T4 |
| **联动** | `docs/code-map.md` 的"已知未修正"在 T5 落地后销号 |

### T6 · 撤池回到纯 U（§5.3.2）—— ✅ **已完成（2026-10-02，双 DEX 实盘）**

| 项 | 内容 |
|---|---|
| **现状** | 撤池后不换 U，钱包留下股票代币 |
| **做什么** | Collect Fees → Remove 100% → **两腿（含 fee 里的股票代币）全部换成 U** |
| **触及** | `src/execution/positionExecutor.ts`、撤池路径 |
| **必须处理** | 每笔等落块；换 U 同样走 §40/§41 闸门与滑点上限 |
| **验收** | 实盘：撤池 → 钱包只剩 U（`balanceOf(stockToken) == 0`）。**2026-10-02 已通过**：两腿+fee 全换 U；NFT 双侧烧毁（Uniswap 补 burn 支路 + 零流动性 shell 的 collect+burn）；钱包收官 USDT 19.548065（起点 19.553，全程损耗 ≈ swap fee）。证据：`docs/research/evidence-live-exit-20261002.txt` |
| **依赖** | T5 |

### T7 · 持仓估值 + APR（§4.2.1）—— ✅ **已完成（2026-10-02，实盘读数）**

| 项 | 内容 |
|---|---|
| **现状** | 能读 tokenId/流动性，未按 §4.2.1 口径折算 |
| **做什么** | 读 LP 实际余额 + 未领 fee → 折 U；APR 分母 = **建仓前投入的 U**（`entryEquityUsd` 已是此值，需核对） |
| **触及** | `src/strategy/nav.ts`、`src/execution/portfolioMonitor.ts` |
| **必须处理** | fee 折 U **单独可见**；分母不得含 swap 损耗 |
| **验收** | `/nav`、`/position` 给出仓位价值、fee 价值、合计、APR。**2026-10-02 已通过**：实盘（Pancake 建仓→读数→撤池回纯U），腿值 6.5471+7.1428、fee collect-读数、权益 13.6899、APR 年化打印；分母 = 建仓前 U ✓。渲染层单测覆盖。证据：`docs/research/evidence-live-value-20261002.txt` |
| **依赖** | 无 |

### T8 · 资金归一化（建仓前清成纯 U）—— ✅ **已完成（2026-10-02，实盘负例验证）**

| 项 | 内容 |
|---|---|
| **现状** | `funding.ts` 只处理「报价币缺口」，不处理「钱包残留股票代币」 |
| **做什么** | 由 §5.3.1/§5.3.2，建仓前钱包**应当**是纯 U。**检测到残留股票代币 → 不是走自平衡分支，而是报缺陷并拒绝** |
| **触及** | `src/strategy/funding.ts` |
| **必须处理** | 拒绝信息须指出「上次退出不完整」 |
| **验收** | 注入残留代币 → 建仓被拒并说明原因（而不是自行卖出）。**2026-10-02 已通过（实盘负例）**：真金买入 1338 wei QQQB → 建仓被 `WALLET_NOT_PURE_U` 拒绝且拒信精确列出 `Found: QQQB 1338`；§16 admission temp 提高过（config-test-qqqb，用后已删）。残留读法：registry 白名单股票代币一笔 multicall3 + 两个 NPM NFT 计数（不做全链枚举——不知名代币不是"上次退出不完整"的证据，且 §8/§12 本来就拒绝读它）。证据：`docs/research/evidence-funding-gate-20261002.txt` |
| **依赖** | T6 |

---

## P1 · 查询（你能不能看见）

### T9 · 8 个查询命令接线 —— ✅ **早已接线（2026-09-30 落地，本日核对）**

| 项 | 内容 |
|---|---|
| **现状** | `runtime.ts` `queryHandlers: createQueryHandlers({ cache })` 已注入；`/status /position /pools /nav /risk` 经 Telegram 渲染（含 /help 兜底），数据源=最近一轮估值缓存（不现场打链） |
| **做什么** | 在 runtime 注入 `queryHandlers`，数据源为**最近结果缓存** |
| **触及** | `src/runtime.ts`、`src/notify/telegram.ts` |
| **硬约束** | **只读缓存**，不得现场触发扫描/链上读取（否则限流被打爆、Telegram 超时） |
| **验收** | 8 条命令各返回真实数字，无 "not wired"。**核对（2026-10-02）**：/position 已含 T7 的 仓位价值/fee/合计/APR 行；动作命令 /exit /start /resume 另走 actionHandlers。销号（无需实现） |
| **依赖** | 无 |

---

## P1 · 换池闭环（系统能不能持续）

### T10 · 撤池后重新选池 —— 🗑️ **取消（2026-10-02 D3.8：无自动重建）**

| 项 | 内容 |
|---|---|
| **现状** | `/exit` **返回文案声称会重新选池**；`SELECT_POOL` 无消费者 |
| **做什么** | 消费 `SELECT_POOL` 状态 → 进入 T1 选池流程 |
| **触及** | `src/runtime.ts`、`src/execution/actionHandlers.ts`、`src/strategy/stateMachine.ts` |
| **验收** | `/exit` → 观察到重新选池 → 构造出新的建仓交易 |
| **依赖** | T4 |
| **附带** | 若行为无法与文案一致，**必须改掉文案** —— 不允许留虚假承诺 |

### T11 · 换池成本上限 —— 🗑️ **取消（依附 T10/T12 的自动重建，随之取消）**

| 项 | 内容 |
|---|---|
| **现状** | `approveRebuild` 接口存在、无实现 |
| **做什么** | 撤池 + 重建成本上限（§6.4 / §30/§31） |
| **验收** | 超上限 → 拒绝并说明；未超 → 放行 |
| **依赖** | T10 |

### T12 · 风控驱动的换池（自动闭环） —— 🗑️ **取消（2026-10-02：风控自动撤池也停 IDLE 等 /start）**

| 项 | 内容 |
|---|---|
| **现状** | 灾难级自动撤池**已接线**；撤完不重建 |
| **做什么** | 自动撤池 → 自动选池 → 自动建仓（**风控事件豁免收益门槛与冷却**，§32） |
| **验收** | 注入风控触发 → 观察自动撤池 → 自动构造新的建仓交易 |
| **依赖** | T10 |

---

## P2 · 指标完整性

### T13 · Benchmark 组合

| **现状** | 无实现 → **IL 与 Fee/IL Ratio 不可算** |
|---|---|
| **做什么** | 建仓时构造同比例 Buy & Hold 对照组合 |
| **验收** | 建仓后能报告 IL 与 Fee/IL Ratio |
| **依赖** | T4 |

### T14 · Fee/IL Ratio 风控判定

| **现状** | 「收益覆盖不了无常损失」无法判定 |
|---|---|
| **做什么** | 基于 T9 的 IL，判定 `Fee/IL Ratio < 1` |
| **验收** | 构造 IL 超过 fee 的场景 → 判定触发 |
| **依赖** | T13 |

---

## 顺序

```text
P0   T1 → T2 → T3 → T4
     T5（并行，让你能观察）

     ▼ 检查点 A：你实测 /start → 确认 → 构造出交易

P1   T6 → T7 → T8

     ▼ 检查点 B：你实测 /exit → 自动重建；风控触发 → 自动换池

P2   T9 → T10
```

**T4 后停下等你实测**，确认后再做 T6。

---

## 纪律

1. 每个 T 完成后，更新 [`feature-list.md`](../product/feature-list.md) 对应条目，**附实测证据**。
2. **未实测不得标 ✅。**
3. 发现新的「写了没接」，**新增条目**，不得绕过。
4. 删除任何「声称会做但没做」的文案 —— **文案要么与行为一致，要么不写**。
