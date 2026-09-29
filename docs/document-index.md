# Document Index

| 路径 | 类型 | 层级 | 说明 |
|---|---|---|---|
| `PROJECT.md` | 概览 | L0 | 项目定位、当前迭代、范围、导航 |
| `AGENTS.md` | 规则 | L0 | 项目级执行参数、领域硬性约束、门禁分级 |
| `docs/product/stock-lp-auto-strategy-v1.md` | 产品基线 | L2 | **canonical**：对象、边界、能力、验收模型、配置 |
| `docs/iterations/iteration-1.md` | 迭代 | L3 | Iteration 1 范围、阶段、风险、状态 |
| `docs/decisions/D1-scope-and-stack.md` | 决策 | L3 | D1：首期范围、技术栈、密钥方案、编号路径约定 |
| `docs/code-map.md` | 索引 | L1 | 代码入口、模块、测试位置 |
| `docs/known-issues.md` | 登记 | L1 | 遗留问题与已知保留 |
| `docs/archive/tasks/` | 归档 | L4 | 各任务的 Plan / Implementation / Review / Test / Settlement |

## 产品基线章节地图（`docs/product/stock-lp-auto-strategy-v1.md`）

| 主题 | 章节 |
|---|---|
| 目标与不做清单 | §1 |
| 设计原则 / Net Yield | §2 |
| 资金模型 / Reserve | §3–§4 |
| NAV / Benchmark | §5–§6 |
| Fee/IL Ratio | §7 |
| Token 白名单与风险等级 | §8–§9 |
| Stablecoin / Chain / DEX 白名单 | §10–§12 |
| Pool 标识 / Scanner / 快照 | §13–§15 |
| 硬性过滤 / APR 计算 / Net APR / Incentive Haircut | §16–§20 |
| Ranking 与各 Score | §21–§26 |
| 目标收益 / 下降规则 / 换池原则 / Switching Cost / Break Even / Cooldown | §27–§32 |
| Range / Tick 对齐 / 建仓数学 / Optimal Swap | §33–§38 |
| Swap 流程与风控 / Quote TTL / 原子性 / 失败处理 | §39–§43 |
| 状态机与主流程 | §44–§45 |
| MONITOR / 价格行为 / 边界与出界处理 | §46–§53 |
| 脱锚定义与分级 / Market Hours / Emergency | §54–§58 |
| TVL 崩溃 / Reserve 监控 | §59–§60 |
| 收益处理 / Fee Collection / Profit Vault | §61–§64 |
| 全局风险线 / Trigger / Risk Off / 禁止补仓 | §65–§68 |
| Pool Replacement / Candidate / Switch 流程 / 安全 | §69–§73 |
| Persistence / 数据模型 | §74–§77 |
| Alert / Dashboard | §78–§79 |
| 模块与 Adapter 接口 | §80–§84 |
| Config（strategy / tokens / stablecoins） | §85–§87 |
| 状态机图 / Scheduler / 周报 | §88–§90 |
| 执行权限 / 钱包与密钥安全 / 交易保护 / Fail Closed / Idempotency / 交易状态 / RPC 容错 / 价格校验 | §91–§100 |
| Backtest / Simulation / Rollout | §101–§103 |
| 健康分级（Health / Warning / Unhealthy / Critical） | §104–§107 |
| V1 验收清单 | §108 |
| 开发阶段 | §109 |
| V1 摘要 | §110–§112 |
