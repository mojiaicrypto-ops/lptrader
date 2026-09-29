# D2 — 项目 onboarding 与 Iteration 1 Plan（Phase 3 单池实盘）

```yaml
plan:
  task: D2
  goal: >
    交付一个 TypeScript/Node 的股票代币 LP 自动管理工具，在 BNB Chain 上对
    「白名单股票代币 × 白名单稳定币」池完成：只读组合与池子监控 → 集中流动性
    建仓（optimal ratio，非固定 50/50）→ 区间/脱锚/全局风控 → 仓位退出，
    全程可审计（决策日志 + SQLite 持久化），签名私钥以启动口令派生的 AES-256-GCM 落盘。
  requirements:
    - §108 Portfolio: 读钱包余额 / 读 LP Position / 读未领取 Fee / 算 NAV / 算 Reserve Ratio
    - §108 Pool Scanner: TVL / 24h Volume / 7D Volume / Fee Tier / Active Liquidity
    - §108 Pool Filter: TVL / Volume / Token 白名单 / Stablecoin 白名单 / DEX 白名单 / NAV Deviation
    - §108 Position Planning: Upper/Lower / Tick 对齐 / Token0-Token1 最优比例 / Swap Amount
    - §108 Swap: Quote / Slippage Check / Price Impact Check / Deadline / Balance Verification
    - §108 LP: Add Liquidity / Position Verification / Collect Fee / Remove Liquidity
    - §108 Risk: Peg Warning / Global Drawdown / TVL Collapse / Out Of Range / Emergency Pause
    - §95–§98: 交易前校验 / Fail Closed / Idempotency / 交易状态机（UNKNOWN 不自动重发）
    - §93–§94: 禁止无限授权；私钥不入源码、不入日志
  in_scope:
    - 项目骨架：TS + Node、config 加载与校验、白名单 Registry（以合约地址为主键）
    - security/keystore：启动口令 → scrypt 派生 → AES-256-GCM 解密私钥（仅内存）
    - chain/BSC ChainAdapter（viem，多 RPC 故障切换）
    - 链上只读层：pool slot0/liquidity/fee、token 余额、BEP-677 UI 换算与 uiMultiplier 读取
    - data：PoolScanner + PoolFilter + PoolDataProvider（GeckoTerminal/DexPaprika/RPC 三层）+ ReferencePriceProvider
    - strategy：PositionPlanner（CL 数学 + tick 对齐 + optimal ratio）+ SwapPlanner（quote/impact/slippage）
    - execution：SwapExecutor + LiquidityManager（原子路径优先，失败转 PARTIAL_POSITION）
    - risk：RiskManager（脱锚分级、回撤线、TVL 崩溃、out-of-range）+ Emergency
    - state：StateMachine（§44）+ StateStore（SQLite）+ 交易状态机
    - benchmark：BenchmarkEngine（建仓时同比例 HODL）→ Fee/IL Ratio
    - notify：Telegram 告警（Critical 分级）
    - 调度：5min 组合监控 / 15min 池健康 / 60min 池扫描
    - 验证：单元测试（数学、过滤、风控阈值）+ 链上只读冒烟脚本 + 建仓 dry-run（编码 calldata 不发送）
  out_of_scope:
    - 自动换池（Phase 5）、多池排序决策（Phase 4）、多链/多 DEX 扩展（Phase 6）
    - Backtest 引擎（§101）、Paper Trading 引擎（§102）→ 独立迭代
    - 自动复投 compound（基线恒 false）
    - Web Dashboard（§79）→ 首期以 CLI/日志+告警替代；Dashboard 独立迭代
  tasks:
    - id: T1
      owner: dev
      change: 初始化 TS 项目（package.json/tsconfig/ESLint/vitest），锁定 viem 2.37.13（对齐 @pancakeswap/v3-sdk 精确依赖）
      paths: [package.json, tsconfig.json, vitest.config.ts]
      verify: [npm run typecheck, npm test]
    - id: T2
      owner: dev
      change: config 加载 + 白名单 Registry（地址为主键，含 bStocks 8 地址与 USDC/USDT/WBNB），schema 校验，白名单为空时拒绝建仓
      paths: [src/config/**, tests/config/**]
      verify: [npm test -- config]
    - id: T3
      owner: dev
      change: security/keystore：scrypt(maxmem 显式抬升) + AES-256-GCM 版本化信封；解密失败硬失败；不进日志
      paths: [src/security/keystore.ts, tests/security/**]
      verify: [npm test -- keystore]
    - id: T4
      owner: dev
      change: chain/BSC ChainAdapter（viem public/wallet client、多 RPC、multicall3 批读、sendTransaction + 交易状态机）
      paths: [src/chain/**, tests/chain/**]
      verify: [npm test -- chain, node scripts/smoke-read.ts]
    - id: T5
      owner: dev
      change: 链上只读层：pool slot0/liquidity/fee、token 余额、BEP-677 UI 换算（balanceOfUI/toUIAmount/uiMultiplier）
      paths: [src/chain/poolReader.ts, src/chain/tokenReader.ts, tests/chain/**]
      verify: [node scripts/smoke-read.ts]
    - id: T6
      owner: dev
      change: data/PoolDataProvider 三层（GeckoTerminal → DexPaprika → RPC 真值）+ 限流退避（429）；PoolScanner + PoolFilter（§16 硬性过滤）
      paths: [src/data/**, tests/data/**]
      verify: [npm test -- pool, node scripts/smoke-scan.ts]
    - id: T7
      owner: dev
      change: data/ReferencePriceProvider：Binance index price（含 price<=0 占位判定）+ 现货 ticker + 市场开闭判定；降级为仅报警
      paths: [src/data/referencePrice.ts, tests/data/referencePrice.test.ts]
      verify: [npm test -- referencePrice]
    - id: T8
      owner: dev
      change: strategy/PositionPlanner：CL 数学（maxLiquidityForAmounts / SqrtPriceMath 等价实现）、tick 对齐、optimal token0/token1 ratio、swap amount 反推
      paths: [src/strategy/positionPlanner.ts, tests/strategy/positionPlanner.test.ts]
      verify: [npm test -- positionPlanner]
    - id: T9
      owner: dev
      change: strategy/SwapPlanner + execution/SwapExecutor + execution/LiquidityManager：QuoterV2 报价、price impact 自算闸门（0.5%）、slippage（0.3%）、quote TTL、原子 swapAndAdd 优先、失败转 PARTIAL_POSITION
      paths: [src/strategy/swapPlanner.ts, src/execution/**, tests/execution/**]
      verify: [npm test -- executor, node scripts/dry-run-build.ts]
    - id: T10
      owner: dev
      change: risk/RiskManager（脱锚分级 §55、回撤线 §65–§67、TVL 崩溃 §59、reserve §60、out-of-range §49–§51）+ Emergency 触发
      paths: [src/strategy/riskManager.ts, tests/strategy/riskManager.test.ts]
      verify: [npm test -- riskManager]
    - id: T11
      owner: dev
      change: state/StateMachine + StateStore(SQLite)：§44 状态、Position/SwapRecord/DecisionLog 表、交易状态机、幂等键
      paths: [src/strategy/stateMachine.ts, src/store/**, tests/store/**]
      verify: [npm test -- store]
    - id: T12
      owner: dev
      change: benchmark/BenchmarkEngine（建仓同比例 HODL 估值 + IL + FeeILRatio）+ notify/Telegram + main.ts 装配与调度（5/15/60min）
      paths: [src/strategy/benchmark.ts, src/notify/**, src/main.ts, tests/strategy/benchmark.test.ts]
      verify: [npm test, npm run dev -- --dry-run]
  review_focus:
    - Fail Closed：未知状态是否真的不动手（尤其 PARTIAL_POSITION 与 tx UNKNOWN）
    - 单位/小数：BSC USDC/USDT 18 位、BEP-677 UI 换算、tick↔price、sqrtPriceX96 精度
    - 授权安全：是否出现无限授权、是否可能 approve 非白名单地址
    - 私钥：是否可能进日志/异常堆栈/磁盘明文
    - price impact 闸门是否真的在编码前执行，而非依赖 slippage 参数
    - 风控阈值边界（== 阈值时行为）与脱锚分级的路由
  test_plan:
    - npm run typecheck && npm test（全部单元测试）
    - node scripts/smoke-read.ts（真实链上只读：池状态 + 余额 + uiMultiplier + 参考价）
    - node scripts/smoke-scan.ts（真实数据源扫描 + 硬性过滤输出候选池）
    - node scripts/dry-run-build.ts（真实报价 + 完整 calldata 编码，**不发送交易**）
    - 主网真实交易：需用户在 Review+Test 通过后显式确认，单独执行
  document_impact: [docs/code-map.md, docs/iterations/iteration-1.md, docs/known-issues.md, PROJECT.md]
  risks:
    - 池流动性不足（QQQB/USDC 仅 Uniswap V3 $1.77M / QQQB/USDT Pancake $0.62M）→ 由硬性过滤与 §72 switch cost 上限兜底；建仓前 dry-run 校验影响
    - 免费数据源限流（GeckoTerminal 10 req/min）→ 退避 + 缓存 + RPC 兜底
    - `@pancakeswap/v3-sdk` 锁定 viem 精确版本 → 对齐 2.37.13，若冲突加 overrides 并重跑冒烟
    - 企业行动（拆股/分红）改变 uiMultiplier → 监控事件并在生效窗停摆
    - 参考价闭市不可靠 → §57 降级为仅报警，不做硬平仓
  rollback: 全部改动在 git 分支内，未发送任何主网交易；回滚 = 放弃分支。keystore 与白名单均为新增文件，无数据迁移。
  approval: pending
```

## 本 Plan 的确认结论（2026-09-29，用户裁定）

| # | 议题 | 裁定 | 影响 |
|---|---|---|---|
| D3 | 执行授权模式 | **Mode 1：代码写好后直接实盘**（不做 Phase A/B 拆分） | 安全护栏不因此放松：白名单为空拒绝建仓；每笔交易前 §95 校验；Fail Closed 保持。首次真实建仓仍走人工确认（见 D4） |
| D4 | 资金规模与人工闸门 | **首次将资金放入池子（BUILD_POSITION）需确认；换池（SWITCH_POOL）需确认；其余自动操作（collect / 风控退出 / 暂停）不需确认。确认与推送通过真实 Telegram 机器人完成，且机器人需支持查询。** | 新增 **T13：Approval Gate + Telegram 双向机器人**；`Notifier` 成为硬依赖 |
| C3 | `RangeProgress` 口径 | **按基线 §49 字面公式**（`(Current−Lower)/(Upper−Lower)`），**仅驱动 BOUNDARY_WATCH 告警，不参与任何交易决策** | 无需改基线；对称口径的计算不实现 |
| C1 | 池选择 | **扫描白名单安全交叉集**；实际候选为 Uniswap V3 QQQB/USDC 与 PancakeSwap V3 QQQB/USDT，由硬性过滤 + 排序决定 | 不写死单一组合；Registry 与 Scanner 按 §13 唯一标识 |

**范围澄清（不需用户再确认，按基线执行）**：用户提到"自动调仓不需要确认"—— 这是**确认策略**（哪些动作要人工点头），不是**范围授权**。基线 §48 明确禁止 V1 的 Mid-Range Rebalance，§31 把仓位调整限定在换池与风险退出路径。因此："不需确认的自动操作" = `Collect Fees`、`Remove Liquidity`（风险/出界路径）、`GLOBAL_RISK_OFF` 相关动作；**不包含**"价格偏离中心就重新居中"。若确需放开 §48，属产品范围变更，需另行显式确认。

## 新增任务 T13（因 D4）

| id | owner | change | paths | verify |
|---|---|---|---|---|
| T13 | dev | **Approval Gate + Telegram 双向机器人**：① `ApprovalGate`（SQLite 持久化的 pending 队列、TTL 过期、approved/rejected 状态机、幂等键绑定执行动作）；② Telegram bot 长轮询（`getUpdates`），支持 `/status`、`/position`、`/pools`、`/nav`、`/risk` 查询命令，以及内联按钮 **Approve / Reject**；③ `Notifier` 实现（三级告警推送）；④ 只允许 `TELEGRAM_ALLOWED_USER_IDS` 白名单内的用户确认，其余拒绝；⑤ 落 `DecisionLog`。**默认 `TELEGRAM_ENABLED=false`（fail closed）：未配置 token 时 BUILD_POSITION / SWITCH_POOL 一律不执行。** | `src/notify/telegram.ts`, `src/execution/approvalGate.ts`, `tests/notify/**`, `tests/execution/approvalGate.test.ts` | `npm test -- approvalGate`, `wiring: 无 token 时建仓被拒`（真实 TG 联调由用户提供 token 后单独验证） |

**为什么 T13 的 fail-closed 是必须的**：D4 把"建仓/换池"的执行条件绑定到 Telegram 确认。若 Telegram 不可达而系统仍能建仓，则等于承认一个可被沉默绕过的确认门 → 与 §96 Fail Closed 冲突。因此"Telegram 不可用时 = 不建仓、不换池"，而不是"降级为自动执行"。

## 附：为什么首期覆盖 §108 全清单而不是先做 Phase 1

用户选择"直接 Phase 3 起"。为使 §108 验收可用，本 Plan 交付 **Phase 3 所需的全链路 + Phase 1/2 的只读与模拟能力**（dry-run 建仓 = §102 的核心价值子集），但**不含** Backtest 引擎与自动换池。若用户希望进一步缩小到"仅建仓+监控+退出"，请指示削减 T6/T7 之外的哪几项。
