# Document Index

**导航原则**：产品定义与功能状态各只有**一份**；**不存在"重构前/后"版本对比**；历史对比一律归档。

| 路径 | 类型 | 层级 | 说明 |
|---|---|---|---|
| `PROJECT.md` | 概览 | L0 | 定位、产品状态、导航、验收纪律 |
| `AGENTS.md` | 规则 | L0 | 项目级执行参数、领域硬性约束、门禁分级 |
| **`docs/product/lptrader-product.md`** | **产品** | L1 | **唯一权威产品定义**：是什么、闭环、结构、对象、规则、操作面、验收、不变量（附录 A） |
| **`docs/product/feature-list.md`** | **功能** | L1 | **唯一功能状态清单**：逐条功能 + 真实状态 + 验证方式 |
| **`docs/plan/development-plan.md`** | **计划** | L1 | 待开发项、顺序、dry-run 端到端验收定义 |
| `docs/product/stock-lp-auto-strategy-v1.md` | 参考 | L2 | 规则条款细节（§1–§112）；**参考，非权威** |
| `docs/decisions/D1-scope-and-stack.md` | 决策 | L2 | 首期范围、技术栈、密钥方案、编号约定 |
| `docs/decisions/D2-execution-and-approvals.md` | 决策 | L2 | 执行授权、确认闸门、Telegram 双向机器人 |
| `docs/decisions/D3-architecture.md` | 决策 | L2 | 模块划分、排序策略、时序落库、换池触发分类、确认策略 |
| `docs/research/onchain-facts-2026-09-29.md` | 调研 | L2 | 链上事实：bStocks、BEP-677、参考价源、池子实况、数据源 |
| `docs/research/evidence-*.{txt,md}` | 证据 | L4 | 可复现运行证据：链上只读、池扫描、dry-run 建仓 |
| `docs/OPS.md` | 运维 | L1 | 新机器部署与运维 |
| `docs/USAGE.md` | 手册 | L1 | 日常操作（含**命令可用性状态**） |
| `docs/code-map.md` | 索引 | L1 | 代码入口、模块、测试位置 |
| `docs/known-issues.md` | 登记 | L1 | 遗留问题与已知保留 |
| `docs/archive/tasks/` | 归档 | L4 | 任务归档（Plan / Implementation / Review / Test / Settlement） |
| `docs/archive/superseded/` | 归档 | L4 | **已取代文档**（含版本对比，非权威） |

---

## 唯一权威来源（避免二义）

| 问题 | 唯一答案在 |
|---|---|
| 产品是什么 / 规则怎么定 / 怎么验收 | `docs/product/lptrader-product.md` |
| 某功能现在能不能用 | `docs/product/feature-list.md` |
| 接下来做什么、怎么算做完 | `docs/plan/development-plan.md` |
| 为什么当初这么设计 | `docs/decisions/` |
| 为什么某个值是那个值 | `docs/product/stock-lp-auto-strategy-v1.md`（参考） |

**冲突时**：产品文档 > 参考基线；功能列表 > 任何自述状态。

---

## 归档说明

- `docs/archive/tasks/2026-09-29-D2/` — 首个交付任务（Plan → Develop → 独立 Review → Test → Settlement）。
- `docs/archive/superseded/` — 含版本对比的旧文档，见该目录 `README.md`。

---

## 产品基线章节地图（`docs/product/stock-lp-auto-strategy-v1.md`）

> 该文件是**规则细节参考**，不是产品定义。产品定义见 `lptrader-product.md`。

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
| 硬性过滤 / APR / Net APR / Incentive | §16–§20 |
| Ranking 与各 Score | §21–§26 |
| 目标收益 / 下降规则 / 换池 / 成本 / Break Even / Cooldown | §27–§32 |
| Range / Tick 对齐 / 建仓数学 / Optimal Swap | §33–§38 |
| Swap 流程与风控 / Quote TTL / 原子性 / 失败处理 | §39–§43 |
| 状态机与主流程 | §44–§45 |
| MONITOR / 价格行为 / 边界与出界 | §46–§53 |
| 脱锚分级 / Market Hours / Emergency | §54–§58 |
| TVL 崩溃 / Reserve 监控 | §59–§60 |
| 收益处理 / Fee Collection / Profit Vault | §61–§64 |
| 全局风险线 / Trigger / Risk Off / 禁止补仓 | §65–§68 |
| Pool Replacement / Switch 流程 / 安全 | §69–§73 |
| Persistence / 数据模型 | §74–§77 |
| Alert / Dashboard | §78–§79 |
| 模块与 Adapter 接口 | §80–§84 |
| Config | §85–§87 |
| 状态机图 / Scheduler / 周报 | §88–§90 |
| 执行权限 / 密钥安全 / 交易保护 / Fail Closed / Idempotency | §91–§100 |
| Backtest / Simulation / Rollout | §101–§103 |
| 健康分级 | §104–§107 |
| V1 验收清单 | §108 |
| 开发阶段 | §109 |
| V1 摘要 | §110–§112 |
