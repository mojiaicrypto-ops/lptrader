# Known Issues

按严重度登记：`P1` 阻断 / `P2` 重要 / `P3` 次要。修复后销号并保留一行修复记录。

| ID | 严重度 | 状态 | 描述 | 来源 | 关联 |
|---|---|---|---|---|---|
| KI-1 | P1 | open | **L3 硬门禁未纳入真实资金操作**：`AGENTS.md` 的 L3 关键词含 `swap`/`sendTransaction`，但"主网真实资金执行"仅由 Plan 确认段的规则约束，未做机械拦截（无 dry-run 强制、无金额上限校验）。 | Onboarding 决策 D1 | AGENTS.md / 执行层 |
| KI-2 | P1 | **resolved** | ~~`RangeProgress` 定义与 Range 上下限口径不一致~~ → 用户裁定：按基线 §49 字面公式，仅驱动 `BOUNDARY_WATCH` 告警，不参与交易决策（见 `docs/decisions/D2-execution-and-approvals.md`）。 | 调研 C3 | §33 / §49 |
| KI-3 | P1 | open | **BEP-677 Scaled UI Amount 未纳入基线与循环**：所有余额/份额必须走 UI 换算（`balanceOfUI`/`toUIAmount`）且 `uiMultiplier()` 不得硬编码；企业行动（拆股/分红 ex-date）会暂停存取与交易，需要停摆逻辑。 | 调研 §2 | §5 / §75 |
| KI-4 | P1 | open | **`tick` / `liquidity` 无任何免费 HTTP API 提供** → 必须实现链上读取层（viem multicall `slot0()`/`liquidity()`/`fee()`）；`fees24h/7d` 无免费直供，只能 `volume × feeTier` 推导或走需 key 的 subgraph。 | 调研 §4.2 | §15 / §18 |
| KI-5 | P2 | open | **BSC `eth_getLogs` 受限**（官方 dataseed 禁用；Ankr 限 1000 区块；QuickNode 免费试用限 5 区块）→ 事件驱动设计必须小窗口分页或 WS。 | 调研 §4.2 | §98 / §99 |
| KI-6 | P2 | open | **`@pancakeswap/v3-sdk` 精确锁定 `viem 2.37.13`**，与 viem 最新 2.57.0 冲突 → 需对齐版本或加 overrides 并冒烟验证，否则装出两份 viem。 | 调研 §5 | 依赖层 |
| KI-7 | P2 | open | **同 symbol 异物与 ticker 大小写不一**（`QQQx`/`QQQon`/冒充地址；链上 ticker 小写）→ Registry 必须以地址为主键，禁止 symbol 等值比较。 | 调研 §1 | §8 |
| KI-8 | P2 | open | **闭市期间参考价口径**：无发行方 NAV API；Binance `/fapi/v1/constituents` 仅在部分时段有效且可能返回 `price<=0`/`"-1"` 占位值 → 必须有无效值判定与回退，否则按 §57 降级为仅报警。 | 调研 §3 | §56 / §57 |
| KI-9 | P3 | open | **`AAPLB` / `AMZNB` 无 APRO 链上 feed**；`PLTR` 无 Chainlink feed → 这些符号在首期若要用，只能走 Binance 指数价路径。 | 调研 §3 | §84 |
| KI-10 | P3 | open | **bStocks 合约 ABI 未实证**（Sourcify/Blockscout 404、BscScan 403）：blacklist / upgradeable 权限函数存在性未确认 → 安全评审需补链上 `eth_getCode`/`supportsInterface()` 探测。 | 调研 §6 | §58 |
| KI-11 | P2 | open | **§108 Switching 组部分不在 Iteration 1 范围**：`Search Alternative` / `Compare APR` / `Calculate Switching Cost` / `Break Even Days` 属基线 Phase 5（自动换池）。Iteration 1 只交付确认门 + cooldown 存储。属**经用户确认的范围裁剪**（`docs/decisions/D1-scope-and-stack.md` 第 3 行）。 | §108 vs D1 | §108 / §69–§73 |
| KI-12 | P2 | open | **§101 Backtest / §102 Paper Trading 未实现**：用户选择直接 Phase 3 实盘。§102 的"不发交易"价值子集由 dry-run 建仓脚本部分覆盖，但无 14–30 天 paper 运行期。 | D1（用户选择） | §101 / §102 |
| KI-13 | P2 | open | **§103 Mainnet Rollout 逐步放量未实现**：用户选择 Mode 1 直接实盘且未设 `$500 → $2000 → …` 金额阶梯。风险补偿为 Telegram 确认门 + 白名单非空校验；无程序化金额上限。 | D2（用户裁定） | §103 |
| KI-14 | P1 | open | **Telegram 确认门本身成为单点**：若用户长时间不响应，`BUILD_POSITION` / `SWITCH_POOL` 将永久 pending（fail closed 的正确行为），但**风控退出不受影响**（自动）。需要 TTL 过期后的明确告警与状态可见性。 | D2 设计 | §96 / T13 |
| KI-15 | P1 | open | **§5 NAV 公式与 §64 Profit Vault 不自洽**：§5 写 `TotalNAV = Wallet + LP + Unconfirmed Fees + Realized Fees`，但 §64 的 `Profit Vault = realised fees` 且 reserve 就是钱包余额 → 把 `realizedFees` 再加一次会**重复计算已收手续费**，抬高 NAV 并可能把 NAV 推过 §66 风控线之上，从而**静默关闭亏损保护**。实现取保守读法：**不重复计入**（`realizedFees` 仍计算并落库，只是不作为 NAV 项），低估方向只会让 §66 更早触发。**需用户确认此读法。** | 实现期发现（`src/strategy/nav.ts` 头部注释） | §5 / §64 / §66 |
| KI-16 | P1 | **resolved** | **`src/store/db.ts` 的 `:memory:` 未隔离**：注释称内存库绕过 singleton map，实际 lookup 发生在 in-memory 判断之前且仍写入 map → 两次 `openDatabase(':memory:')` 返回**同一连接**（实测第二个句柄能看到第一个写入的行）。影响范围超出测试：任何以为拿到独立内存库的调用方（dry-run / paper 模式）会与其它组件共享状态。**已修复**：`openDatabase` 对内存库跳过 map 查找与写入（新增 `isMemoryDatabase()` 导出）；`closeDatabase` 改为幂等。owner 提供 red-before 证据（临时回退后 1 failed）与回归测试。 | 实现期发现（executor 测试串味） | §74 / T11 |
| KI-17 | P2 | open | **Notifier 返回不匹配的 `requestId` 时确认门会挂到 TTL 才拒绝**：`settle()` 检测到 id 不符只记日志并 return，waiter 因此等到 `expiresAt`。行为本身是 fail closed（最终拒绝），但会把 executor 挂住整个 TTL（实测 30 分钟级）。建议：id 不符时立即以拒绝结算。 | 实现期发现（executor 测试） | §96 / T13 |
| KI-18 | P2 | open | **`PoolSnapshot.currentTick` / `sqrtPriceX96` / `activeLiquidity` 无可用性位**：三者是冻结的裸类型（非 `Sourced`），RPC 不可达时 provider 写 `0 / 0n / 0n`。`activeLiquidity = 0n` 是合法值（流动性全出区间），`currentTick = 0` 是**合法 tick**，下游无法与真实数据区分。缓解：filter 增加 `onchainVerified !== true` → 拒绝（§96「无法验证即拒绝」），使哨兵值不可达；但该保护依赖所有消费者都走 filter。 | DataTests 发现（D2） | §15 / §16 / §34 |
| KI-19 | P2 | **resolved** | ~~§99 cross-check 在未固定区块高度时对区块可变值（`slot0`/余额/feeGrowth）逐字段全等比较，导致**每一次**真实读取都可能失败~~。**实测**：两个端点返回的 `sqrtPriceX96` 在第 9 位有效数字上不同、`tick` 相同 —— 即一个区块的正常价格波动，却被判为不一致而拒绝。**已修复**：`crossCheck` 先解析并固定一个区块高度，所有观测都在该高度读取；无法固定高度则 fail closed（不退回未固定读取）。回归测试锁定「两次 `eth_call` 带同一非空 block tag」与「两端点均无法报块高 → `RPC_UNAVAILABLE`」。 | 集成期独立验证发现（活链复现） | §99 / §98 |
| KI-20 | P3 | open | **同一次快照内的多字段读取未共享区块高度**：`PoolReader.readPool` 用 `Promise.all` 发起 6 个独立 `readContract`，每个各自固定一个（可能不同的）高度。窗口极小（BSC ~0.75s/块），但理论上会出现 `slot0` 来自块 N、`liquidity` 来自块 N+1 的不自洽快照。彻底修复需支持「一次 crossCheck 内批量多调用」。 | 集成期发现（同 KI-19 的修复引入的观察） | §15 / §99 |
| KI-21 | P1 | **resolved** | ~~`TxGuardChecks` 是调用方自报的布尔值，`assertTxGuard` 只**重新推导** `ok`、不验证任何事实 → 一个把所有子项填 `true` 的伪造 guard 指向**非白名单地址**可以通过检查~~。**实测**：伪造的 all-true guard 指向已知冒充地址 `0xb904108b…` 被 `assertTxGuard` 接受。由于 `sendTransaction` 是全系统唯一写路径，这使「签给错误合约」这个最致命的失败模式仅依赖调用方诚实。**已修复**：`BscChainAdapter.sendTransaction` 在广播前**独立**校验 `tx.to` 必须属于本链白名单 DEX 合约或 Multicall3；回归测试 3 条（伪造 guard + 冒充地址 → 拒；伪造 guard + 任意地址 → 拒；白名单目标 → 负向对照，失败原因须为「缺 signer」而非「目标」）。**该检查立即发现 Pancake SmartRouter（§42 原子建仓的目标合约）不在白名单中** → 已补入 `BSC_DEX_CONTRACTS`。 | 独立评审（ReviewSafety 提出的问题）+ 集成期实测确认 | §95 / §91 / §8 |

## 已登记待处理（Onboarding 阶段产生）

> 以下为待 Phase 3 实现前必须收敛的**已知缺口**，不是缺陷：
> - 参考价（Reference NAV）来源未定：闭市期间 `Alternative Reference Pricing`（§57）需在实现前确认可用 source，否则按基线"Disable Hard Depeg Exit，仅报警"。
> - 池子历史数据源（7D/30D volume 序列、池创建时间）未定：决定 VolumeStabilityScore 与 `min_pool_age_days` 是否可计算，缺则须降级为已知限制。
> - 股票代币官方合约地址未落库：白名单为空的系统**不得**执行任何建仓（Fail Closed）。
