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

## 已登记待处理（Onboarding 阶段产生）

> 以下为待 Phase 3 实现前必须收敛的**已知缺口**，不是缺陷：
> - 参考价（Reference NAV）来源未定：闭市期间 `Alternative Reference Pricing`（§57）需在实现前确认可用 source，否则按基线"Disable Hard Depeg Exit，仅报警"。
> - 池子历史数据源（7D/30D volume 序列、池创建时间）未定：决定 VolumeStabilityScore 与 `min_pool_age_days` 是否可计算，缺则须降级为已知限制。
> - 股票代币官方合约地址未落库：白名单为空的系统**不得**执行任何建仓（Fail Closed）。
