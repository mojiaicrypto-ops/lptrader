# Iteration 1 验收映射（§108 → 实现 → 证据）

> §108 的每一条必须以 **运行证据** 关闭，不以"代码写了"替代。
> 状态：`passed` = 有可复现的运行证据；`partial` = 部分有证据；`not-covered`（须登记 known-issues）/ `blocked`。
> 证据文件在 `docs/research/evidence-*.txt|md`；测试用 `npx vitest run <path>` 复现。

## Portfolio（§108）

| 验收项 | 实现 | 证据 | 状态 |
|---|---|---|---|
| 正确读取钱包余额 | `chain/tokenReader.ts` | `scripts/smoke-read.ts` 真实 RPC 输出（`docs/research/evidence-smoke-read-20260929.txt`）；`tests/chain/tokenReader.test.ts` | passed |
| 正确读取 LP Position | `chain/positionReader.ts` | `tests/chain/positionAndTx.test.ts`（`positions()`/`ownerOf`/枚举）；`tests/execution/portfolioMonitor.test.ts`（`liquidityToAmounts` 由仓位算双腿）；smoke-read (c) 段提供入口 | passed（代码路径与单测全绿；**真实仓位读数**需用户钱包地址，见「未关闭项」） |
| 正确读取未领取 Fee | `chain/positionReader.ts` (`tokensOwed0/1`) | `tests/chain/positionAndTx.test.ts`；`tests/execution/portfolioMonitor.test.ts`（fee 计入 NAV） | passed |
| 正确计算 NAV | `strategy/nav.ts` + `execution/portfolioMonitor.ts` | `tests/strategy/nav.test.ts`（25）；`tests/execution/portfolioMonitor.test.ts`（16，含「不重复计 realizedFees」与「未计价 → complete=false」） | passed |
| 正确计算 Reserve Ratio | `strategy/nav.ts` | `tests/strategy/nav.test.ts`（含 0 NAV 不除零）；`tests/strategy/riskManager.test.ts`（§60 阈值 0.25/0.30 边界） | passed |

## Pool Scanner（§108）

| 验收项 | 实现 | 证据 | 状态 |
|---|---|---|---|
| 正确读取池 TVL | `data/poolDataProvider.ts` | 真实扫描：QQQB/USDC $1,783,477.88、QQQB/USDT $623,813.64，与调研 §4.1 一致（sanity check 两行 OK） | passed |
| 正确读取 24h Volume | 同上 | 同上（QQQB/USDT $6,305,798.33） | passed |
| 正确读取 7D Volume | 同上（DexPaprika） | 同上（QQQB/USDT $35,549,575.5 @ dexpaprika） | passed |
| 正确读取 Fee Tier | `data/poolScanner.ts` + RPC 真值 | 真实扫描 fee 100/2500/3000 与调研一致；DexPaprika `fee: null` 不误判（`tests/data/poolScanner.test.ts`） | passed |
| 正确读取 Active Liquidity | `chain/poolReader.ts`（RPC） | 真实扫描 `activeLiquidity 1511306225692084162659627`；无免费 API 可替代（KI-4） | passed |
| **额外**：区分「不存在」与「读不到」 | `data/poolScanner.ts` | 真实扫描 27+ 条 proven-absent、0 条 unverifiable；`tests/data/poolScanner.test.ts` 覆盖 HTTP 500 ≠ absent | passed |

## Pool Filter（§108）

| 验收项 | 实现 | 证据 | 状态 |
|---|---|---|---|
| TVL Filter | `data/poolFilter.ts` | `tests/data/poolFilter.test.ts`（40 tests，每条含**恰好等于阈值**用例） | passed |
| Volume Filter | 同上 | 同上（关键：用 **7D 均日量**而非 7D 总量，已专测） | passed |
| Token Whitelist | 同上（地址层） | 同上（同名冒充地址 `0xb904108b…` 被拒） | passed |
| Stablecoin Whitelist | 同上 | 同上 | passed |
| DEX Whitelist | 同上 | 同上（仅白名单 Uniswap 时 Pancake 池被拒） | passed |
| NAV Deviation Filter | 同上 | 同上（**严格小于**：恰好 0.01 淘汰） | passed |
| **额外**：fail closed | 同上 | stale/unavailable 字段各自 `*_UNAVAILABLE` 且无 `*_BELOW_MINIMUM`；`decisive=false` 上报 | passed |

## Position Planning（§108）

| 验收项 | 实现 | 证据 | 状态 |
|---|---|---|---|
| 正确计算 Upper / Lower | `strategy/positionPlanner.ts` | `tests/strategy/positionPlanner.test.ts`（36；`700×0.85=595` / `×1.16=812`，并从 config 读比率） | passed |
| Tick 对齐 | 同上 | 同上（Pancake 1/10/50/200、Uniswap 含 60；断言 `%spacing===0`；跨表混用被拒） | passed |
| 正确计算 Token0/Token1 Optimal Ratio | 同上 | 同上（**与 SDK `Position.amount0/amount1` 逐 wei 相等，diff 0**；L 相对差 1.94e-19 且不超过 SDK） | passed |
| 正确计算 Swap Amount | 同上 + `strategy/swapPlanner.ts` | 同上（反例：默认区间下最优 $3346.14 vs 固定 50/50 $3500，偏差 4.60%；更宽区间 15.35%）；`tests/strategy/swapPlanner.test.ts` | passed |

## Swap（§108）

| 验收项 | 实现 | 证据 | 状态 |
|---|---|---|---|
| Quote | `dex/pancakeV3.ts`、`dex/uniswapV3.ts` | `scripts/smoke-quote.ts` 真实输出：卖 1000 USDT → 1.355335 QQQB，impact 0.0123%，ttl 30s；`tests/dex/*`（97 tests） | passed |
| Slippage Check | `strategy/swapPlanner.ts` | `tests/strategy/swapPlanner.test.ts`（>0.3% 拒绝；恰好 0.3% 通过） | passed |
| Price Impact Check | `strategy/swapPlanner.ts`（**本地自算**） | 同上（>0.5% 拒绝；恰好 0.5% 通过；>1% 标记 liquidity risk；池方向反转正确） | passed |
| Deadline | `dex/*` | Pancake：`0x1f0464d1 multicall(bytes32,bytes[])`（`previousBlockhash` 变体，**字节码验证选择器存在于部署合约**）；Uniswap：NPM 无该重载 → 明确**拒绝**而非静默换成 timestamp（已测） | passed |
| Balance Verification | `dex/*` + `execution/positionExecutor.ts` | `tests/dex/*` 的 guard 失败零发送断言；`scripts/dry-run-build.ts` 校验 swap 产出 vs 建仓所需（实测 −0.0100%，在 1% 内，属 mid 价求解 vs 付费成交的预期差） | passed |

## LP（§108）

| 验收项 | 实现 | 证据 | 状态 |
|---|---|---|---|
| Add Liquidity / Position Verification | `dex/*` + `positionExecutor.ts` | `tests/dex/pancakeV3.test.ts`：原子路径 outer selector `0x1f0464d1` + 7 条内层调用顺序（`exactInputSingle`→`pull`→`approve`→mint→sweep×2），**1509 字节** calldata，目标为 SmartRouter `0x13f4ea83…`；`tests/execution/positionExecutor.test.ts` 验证编排 | passed |
| Collect Fee | `positionExecutor.ts` + `dex/*` | `tests/execution/positionExecutor.test.ts`（无需人工确认、halted 时被拒）；`tests/dex/*` collect calldata | partial（实盘 collect 待真实仓位） |
| Remove Liquidity | 同上 | 同上（RISK_REVIEW 下自动退出）；Uniswap 侧 `burn > liquidity` 检查已测 | partial（实盘 remove 待真实仓位） |

## Risk（§108）

| 验收项 | 实现 | 证据 | 状态 |
|---|---|---|---|
| Peg Warning | `strategy/riskManager.ts` | `tests/strategy/riskManager.test.ts`（78；五档边界精确：0.01/0.02/0.03/0.05） | passed |
| Global Drawdown | 同上 | 同上（NAV 恰好 8500 → breached，含 `<=`；8500.01 不触发） | passed |
| TVL Collapse | 同上 | 同上（50%/70% 两级；无历史 → `insufficient-data` 而非默认安全） | passed |
| Out Of Range | 同上 | 同上（`>=upper` / `<=lower` 边界相等） | passed |
| Emergency Pause | 同上 | 同上（9 类条件逐个可触发） | passed |
| **额外**：闭市脱锚只报警 | 同上（§57） | 同上（`closed` + 6%/20%/90% deviation → 仅 critical 告警，`hardExitPermitted=false`） | passed |
| **额外**：下跌但 NAV 同步 → HOLD | 同上（§53） | 同上 | passed |

## Switching（§108）

| 验收项 | 状态 |
|---|---|
| Detect Underperformance / Search Alternative / Compare APR / Calculate Switching Cost / Break Even Days | **not-covered**（基线 Phase 5，Iteration 1 范围外 —— 经用户确认的裁剪，见 KI-11） |
| **额外**：Cooldown 字段持久化 + 确认门 | partial（`Position.cooldownUntil` 与 `ApprovalGate` 已实现；换池决策不在本迭代） |

## 安全与执行（非 §108 但为硬要求）

| 验收项 | 证据 | 状态 |
|---|---|---|
| §95 交易前置校验 | `tests/chain/positionAndTx.test.ts`；`tests/execution/positionExecutor.test.ts`（guard.ok=false → 零编码零发送，且**先于**征求人工确认） | passed |
| §96 Fail Closed | 执行器 + 过滤器 + 参考价 + 扫描器各自 fail-closed 专测 | passed |
| §97 幂等 | `tests/execution/positionExecutor.test.ts`（同 key 第二次 → `ALREADY_EXECUTED`，adapter 不再被调用）；`tests/store/store.test.ts` | passed |
| §98 交易状态机 UNKNOWN 不重发 | `tests/chain/positionAndTx.test.ts`；`tests/store/store.test.ts`（`findUnresolved` + `TxBlockedError`）；smoke 实测 | passed |
| 私钥不入源码/日志/git | `tests/security/keystore.test.ts`（19；错误 passphrase 硬失败且异常不含密钥/passphrase 片段） | passed |
| Telegram 确认门 fail-closed | `tests/notify/telegram.test.ts`（26）+ `tests/execution/approvalGate.test.ts`（29）；无 token → `noopNotifier` → build/switch 不可能 | passed |
| §42 原子建仓全有或全无 | `tests/execution/positionExecutor.test.ts`（atomic 路径恰好 1 笔发送；atomic 抛错**不**回退两笔）；`tests/dex/pancakeV3.test.ts`（outer `0x1f0464d1` + 7 条内层调用，1509 字节，目标 SmartRouter）；`tests/dex/uniswapV3.test.ts`（传 `swapForDeficit` 即抛） | passed |
| 调度不重叠 | `tests/execution/scheduler.test.ts`（13） | passed |

## 端到端 dry-run 证据（`docs/research/evidence-dry-run-build-20260929.txt`）

`npm run dry-run:build -- 7000` 于真实链上数据跑完整决策链（扫描 → §16 过滤 → 计划 → 报价 → §40/§41 闸门），**不签名不发送**：

```text
§16 通过              2 个池（QQQB/USDT @ Pancake 0xe531…；AAPLB/USDT @ Pancake 0xe9b9…）
LP 资本               4900.00（7000 × 0.70）
lower/upperPrice      627.7164 / 856.6482   （= 735.21 × 0.85 / × 1.16）
ticks                 [64424, 67533]，spacing 1，aligned true
value sum USD         4900.00（精确）
optimal vs 固定 50/50  4.400%（2342.19 vs 2450.00）→ §35 反证
swap                  2344.08 USDT → 3.171471 QQQB
priceImpact           0.016550%（适配器）vs 0.015541%（独立复算）→ **exact**
§40 gate              ok
funding               −0.0100%（在 1% 内，预期）
atomicity             单笔（swap + mint 合并）
```

## 新增回归（独立 Review 发现并修复，详见 `review-report.md`）

| 项 | 证据 | 状态 |
|---|---|---|
| 伪造 all-true guard 指向非白名单地址 → 拒（KI-21） | `tests/chain/positionAndTx.test.ts` 3 条 + 负向对照；评审者原探针复验 0 发送 | passed |
| 原子建仓 hash 记主键、可被链上观测解决（KI-22） | `tests/execution/positionExecutor.test.ts`；评审者探针复验 `PRIMARY SUBMITTED` → `CONFIRMED` | passed |
| REVERTED 后重试建立 attempt 2（KI-23） | `tests/execution/positionExecutor.test.ts`；评审者探针复验 `[1,2]` | passed |
| 估值不完整时不产出 §66 判定（KI-24） | `tests/execution/portfolioMonitor.test.ts` 4 条；评审者探针复验 `complete=true / totalNAV=3001.11` | passed |
| §99 区块固定（KI-19） | `tests/chain/rpcFailover.test.ts` 2 条；活链复现 | passed |
| 内存库隔离（KI-16） | `tests/store/store.test.ts` | passed |

## 用户裁定（2026-09-30）后的新增验收

| 项 | 实现 | 证据 | 状态 |
|---|---|---|---|
| §5 NAV 不重复计入 realized fees | 产品基线 §5/§64 已改；`buildPortfolioSnapshot` 早已如此 | `tests/strategy/nav.test.ts`（"does NOT count realized fees a second time"） | passed |
| §3 严格按比例分配 | `src/strategy/allocation.ts` | `tests/strategy/allocation.test.ts`（24 tests：预算=NAV×ratio、**结果态**校验、两次合规建仓不得合起来超比例、Reserve 下限、NAV 不可用即拒） | passed |
| §3 每轮监控并告警（不自动补仓 §68） | `PortfolioMonitor.allocation` | `tests/execution/portfolioMonitor.test.ts`；dry-run 输出 `§3 allocation OK — LP 4900.00 of NAV 7000.00 (cap 70%)` | passed |
| §40 单笔容忍度可**按池**配置 | `strategy.yaml.pool_overrides` → `swapLimitsForPool()` → 门禁 | `tests/strategy/allocation.test.ts`（§40 override 组）；**dry-run 实测**：Pancake 池 `slippage 0.80% / impact 0.80%`（覆盖生效），Uniswap 池 `0.30% / 0.50%`（全局默认） | passed |
| §16 准入与 §40 执行容忍度分离 | 产品基线 §16/§40/§85 已改；类型层拆为 `PoolThresholdConfig.maxSwapPriceImpact` vs `SwapConfig.maxPriceImpact` | 同上；启动时拒绝「覆盖值低于准入阈值」 | passed |
| 执行器加分配门 | `ALLOCATION_EXCEEDED` | `tests/execution/positionExecutor.test.ts`（含新增输入字段） | passed |

## 未关闭项汇总

- **实盘仓位类证据**（真实 AUM 下的 collect / remove / 首次 build、真实 LP 仓位读数）需用户提供签名钱包与真实仓位 —— 属 D2 确认门的正常结果，**非缺陷**。代码路径、calldata 编码与编排均已由单测 + dry-run 覆盖。
- Switching 组按 D1 范围裁剪，已登记 KI-11。
- KI-15（NAV 公式读法）与 KI-17/KI-18/KI-20 待用户/后续处理，已在 `docs/known-issues.md` 登记。
