# Iteration 1 验收映射（§108 → 实现 → 证据）

> §108 的每一条必须以 **运行证据** 关闭，不以"代码写了"替代。
> 状态：`passed` = 有可复现的运行证据；`partial` = 部分有证据；`not-covered`（须登记 known-issues）/ `blocked`。
> 证据文件在 `docs/research/evidence-*.txt|md`；测试用 `npx vitest run <path>` 复现。

## Portfolio（§108）

| 验收项 | 实现 | 证据 | 状态 |
|---|---|---|---|
| 正确读取钱包余额 | `chain/tokenReader.ts` | `scripts/smoke-read.ts` 真实 RPC 输出（`docs/research/evidence-smoke-read-20260929.txt`）；`tests/chain/tokenReader.test.ts` | passed |
| 正确读取 LP Position | `chain/positionReader.ts` | `tests/chain/positionAndTx.test.ts`（`positions()`/`ownerOf`/枚举）；smoke-read 的 (c) 段（需 `STRATEGY_WALLET_ADDRESS` + `LP_POSITION_TOKEN_ID`） | partial（真实仓位待用户提供地址/ tokenId） |
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
| Quote | `dex/pancakeV3.ts`、`dex/uniswapV3.ts` | `scripts/smoke-quote.ts`（真实 QuoterV2） | blocked（适配器在飞行中） |
| Slippage Check | `strategy/swapPlanner.ts` | `tests/strategy/swapPlanner.test.ts`（>0.3% 拒绝；恰好 0.3% 通过） | passed |
| Price Impact Check | `strategy/swapPlanner.ts`（**本地自算**） | 同上（>0.5% 拒绝；恰好 0.5% 通过；>1% 标记 liquidity risk；池方向反转正确） | passed |
| Deadline | `dex/*`（calldata 断言） | 待适配器 | blocked |
| Balance Verification | `dex/*` + `execution/positionExecutor.ts` | 待适配器 | blocked |

## LP（§108）

| 验收项 | 实现 | 证据 | 状态 |
|---|---|---|---|
| Add Liquidity / Position Verification | `dex/*` + `positionExecutor.ts` | `tests/execution/positionExecutor.test.ts`（22）验证执行编排；calldata 待适配器 | partial |
| Collect Fee | `positionExecutor.ts` | 同上（条件触发、无需人工确认、halted 时被拒） | partial |
| Remove Liquidity | 同上 | 同上（RISK_REVIEW 下自动退出） | partial |

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
| §42 原子建仓全有或全无 | `tests/execution/positionExecutor.test.ts`（atomic 路径恰好 1 笔发送；atomic 抛错**不**回退两笔） | passed（编码待适配器） |
| 调度不重叠 | `tests/execution/scheduler.test.ts`（13） | passed |

## 未关闭项汇总

- **Swap/LP 组的 calldata 级证据**等 `src/dex/**` 落地（当前 `blocked`，非失败）。
- **真实 LP 仓位读数**需用户提供 `STRATEGY_WALLET_ADDRESS` + `LP_POSITION_TOKEN_ID`（当前无实盘仓位，属正常）。
- Switching 组按 D1 范围裁剪，已登记 KI-11。
