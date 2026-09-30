# D2 — 执行授权、确认闸门与 Telegram 机器人

**日期**：2026-09-29
**状态**：用户已确认
**关联**：`docs/archive/tasks/2026-09-29-D2/plan.md`

## 决策

| # | 议题 | 裁定 | 与基线的关系 |
|---|---|---|---|
| D3 | 执行授权模式 | **Mode 1：代码写好后直接实盘**（不做 Phase A 只读 / Phase B 实盘的开关拆分） | 偏离基线 §103 的 Stage 1–4 逐步放量建议。风险补偿：白名单为空拒绝建仓；每笔交易前 §95 校验；Fail Closed；T13 的确认门。**§103 逐步放量作为待立项独立迭代**。 |
| D4 | 人工确认闸门 | **需要人工确认的动作：`BUILD_POSITION`（首次把资金放入池子）与 `SWITCH_POOL`（换池）。其余动作自动执行。** 确认经**真实 Telegram 双向机器人**完成，机器人同时承担推送与查询。 | 基线 §91 允许自动执行全部五类动作；本决策**收紧**（不放松），与 §2.1 Risk First 一致。 |
| C3 | `RangeProgress` | 按 §49 字面公式，**仅告警**，不参与交易决策 | 与 §33 的 −15%/+16% 区间不冲突（不改任一公式）。 |
| C1 | 池选择 | 扫描白名单安全交叉集；候选 = Uniswap V3 QQQB/USDC 与 PancakeSwap V3 QQQB/USDT | §12 白名单已含两个 DEX；§110 已含 USDC/USDT。无需改基线。 |

## 「自动调仓」的口径澄清（重要）

用户原话"自动调仓不需要确认"被解读为**确认策略**（哪些动作需要人工点头），而非**范围授权**：

- `Collect Fees`、`Remove Liquidity`（风险/出界路径）、`GLOBAL_RISK_OFF` 动作 → 自动，不需确认。
- **不包含**「价格偏离中心就重新居中」—— 基线 §48 明确禁止 V1 的 Mid-Range Rebalance。
- 仓位调整仅发生在：换池（需确认）、风险退出（自动）、全局风控（自动）。

若需放开 §48，属产品范围变更，需另行显式确认。

> ⚠️ 此口径是我从「确认策略」维度做的保守解读。**若用户本意是放开 §48 的 mid-range rebalance 限制，须明确纠正。**

## Telegram 机器人需求（T13）

| 能力 | 要求 |
|---|---|
| 推送 | 三级告警（info / warning / critical，对应基线 §104–§107），Critical 直接推 |
| 查询 | `/status`、`/position`、`/pools`、`/nav`、`/risk` 等只读查询 |
| 确认 | `BUILD_POSITION` / `SWITCH_POOL` 的内联按钮 Approve / Reject，带 TTL 过期 |
| 鉴权 | 只接受 `TELEGRAM_ALLOWED_USER_IDS` 白名单内用户的确认；其余忽略并记日志 |
| 审计 | 每次推送与每次确认/拒绝都落 `DecisionLog` |
| **Fail Closed** | `TELEGRAM_ENABLED=false` 或 token 缺失时，**BUILD_POSITION / SWITCH_POOL 一律不执行**（不得降级为自动执行） |

实现方式：长轮询 `getUpdates`（避免公网 webhook 暴露，符合 AGENTS.md「公网部署需确认」）。依赖：仅 `fetch`（Node 内置），不引入 Telegram SDK。

## D3 — 后续三项用户裁定（2026-09-30）

| # | 议题 | 裁定 | 落地 |
|---|---|---|---|
| D5 | NAV 算法 | **哪种更合理就用哪种；产品文档不合理就先改文档** → `Realized Fees` **不**作为 NAV 加项（重复计入会静默关闭 §66） | 产品基线 §5/§64 已改；实现早已如此；KI-15 关闭 |
| D6 | 资金与比例 | **不需要程序化金额阶梯**；资金由用户**手动逐步增加**。系统职责 = **严格按配置比例执行 + 持续监控** | 新增 `src/strategy/allocation.ts`：`lpBudgetUsd` / `checkBuildAllocation`（按**结果态**校验，两次合规建仓不得合起来超比例）/ `verifyPostAllocation`（每轮监控）；执行器加 `ALLOCATION_EXCEEDED` 门；监控器每轮输出 allocation；KI-13 关闭 |
| D7 | L3 评审独立性 | **暂不需要**配置独立模型 | review-report 记明"同模型 + 隔离会话"，不再作为待决项 |
| D8 | §16 与 §40 阈值 | **分离**：§16 = 池准入（池深），§40 = 单笔执行容忍度，且**可按池覆盖**（例如某池 0.8% 或 1%） | 产品基线 §16/§40/§85 已改；`strategy.yaml` 新增 `pool_overrides`（key 为 §13 池标识）；`swapLimitsForPool()` 接入门禁；启动时校验覆盖值不得低于准入阈值；KI-28 关闭 |

## 未决

- 用户需提供真实 `TELEGRAM_BOT_TOKEN` 与 chat/user id 才能做真实联调；在那之前 T13 以单测 + 本地假服务器验证。

## 后果

- `Notifier` 成为策略执行的硬依赖（而非可选旁路）→ 接口在 T1 冻结，实现于 T13。
- 「首次建仓需确认」意味着系统启动后不会自动建仓；必须先完成一次 Telegram 往返。
