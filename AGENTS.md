# AGENTS.md — 项目级执行参数

> 本文件由 `agentdev-project-workflow` skill 的 Project Onboarding 生成（见 `references/onboarding.md`），随流程复盘演进。
> 本文件只声明**强制项与参数**，不转述流程细节（流程见 skill `SKILL.md`）。修改本文件需用户确认。

## 项目

| 项 | 值 |
|---|---|
| 项目 | `lptrader` — Tokenized Stock LP Auto Strategy（股票代币集中流动性自动管理系统） |
| 产品基线 | `docs/product/stock-lp-auto-strategy-v1.md`（**canonical**，唯一权威产品事实来源） |
| 技术栈 | TypeScript / Node |
| 首期范围 | Phase 3 单池实盘：QQQB / USDC @ BNB Chain / PancakeSwap V3 |
| 运行目标 | BNB Chain（chainId 56），DEX 白名单：PancakeSwap V3、Uniswap V3 |

## 适用范围

本契约适用于**本项目的需求开发与正式交付**：

- 代码变更（后端 / 脚本 / 迁移 / 链上交互）
- 正式文档变更（`PROJECT.md`、`docs/product/**`、迭代文档、索引、技术文档、契约）
- 任务交付（功能、修复、迭代、Settlement）

**不强制走完整流程**（轻量处理，不设阶段门）：纯讨论、问答、调研、探索性分析（read-only，不落正式文档）。**但**：调研/讨论结论一旦要**落地为代码或正式文档变更**，即转入严格流程执行。

## 领域硬性约束（来自产品基线，违反即视为缺陷）

1. **Risk First**：`资金安全 > Token 正常 > Liquidity 正常 > 收益稳定 > APR 高低`。
2. **Contract Address > Token Symbol**：任何 token 识别与授权必须比对**合约地址白名单**，禁止用 symbol 判断。
3. **Net APR > Frontend APR**：禁止使用前端 APR/APY 作为决策依据，必须本地独立计算。
4. **NAV > Wallet Balance**：组合价值必须含 LP 仓位、未领取 fee；不得只看钱包余额。
5. **Optimal LP Ratio > Fixed 50/50**：建仓必须先按 `P=current, Pa, Pb, Capital` 反推 `L` 与 `amount0/amount1`，再决定 swap 数量。
6. **Fail Closed > Guess And Trade**：未知状态一律 `DO NOTHING`；交易状态 `UNKNOWN` 必须先查链确认，禁止自动重试。
7. **白名单铁律**：不得 `Approve Unknown Contract` / `Transfer Funds To Unknown Address` / `Bridge` / `Borrow` / `Leverage` / 交互未知 DEX。Allowance 禁止无限授权。
8. **禁止自动补仓**：`InitialStrategyCapital` 由用户显式设置；禁止因亏损自动调用外部资金。
9. **禁止 Mid-Range Rebalance**（V1）；禁止高频 Rebalance / 自动追涨 / 无限制 Compound。

## 密钥管理（用户决策）

- 系统启动时由用户**输入加密口令（passphrase/key）**，私钥以 **AES-256-GCM**（`node:crypto`）加密落盘，密钥经 **scrypt/PBKDF2** 派生。
- **禁止**私钥明文入库、入源码、入日志、入 git；`DES` 不可用于本用途（密钥 56-bit，已废弃），一律 AES。
- 进程内私钥仅驻内存，落盘一律密文；口令不落盘。
- 实盘签名账户必须是**独立 Strategy Wallet**，只放策略允许损失的金额。

## Plan 确认

- 涉及产品行为 / 范围 / 验收 / 规则变更 → **必须显式确认**。
- 纯技术执行（无产品语义）→ Plan 提交后一轮无异议视为确认。
- **运行环境操作**（启动/重启/停止服务、修改运行 env、公网暴露/隧道、数据清理/删除、数据库迁移）→ 必须先说明并获确认。
- **真实资金操作**（主网签名交易、真实 swap / addLiquidity / removeLiquidity / collect、动用真实私钥）→ 必须先说明并获**显式**确认；代码提交不等于授权执行。代码编辑与本地测试属开发常规操作，不受此限。

## 门禁分级

- **L1 轻量**：一句话 Plan（不写 plan.md、不等待确认）→ Develop → 1 个独立 reviewer 验证 → Settlement。
  - 条件：纯样式/文档/注释/调整，diff ≤ 20 行，无产品语义。
- **L2 标准**（默认）：Plan（确认）→ Develop → 独立 Review → 独立 Test → Settlement。
- **L3 重型**（命中即自动升级，不可自降）：Plan + Develop + Review（逐条对照 Plan 验收）+ Test（运行证据前置，含 dry-run/模拟）+ Settlement。
  - **L3 关键词**：`私钥` `privateKey` `private key` `签名` `sign` `sendTransaction` `swap` `addLiquidity` `removeLiquidity` `collect` `approve` `allowance` `mainnet` `主网` `白名单` `whitelist` `KMS` `转账` `授权` `nav` `NAV` `peg` `脱锚` `liquidation` `drawdown` `回撤`。
  - 说明：本项目**所有链上写操作**（含测试网）默认 L3；**只读链上/数据源**类改动按 L2。

## Settlement 硬性验收

任一未满足 = 任务未完成，不得声明 Completed。

1. 更新正式文档：`PROJECT.md`、迭代文档、`docs/document-index.md`、`docs/code-map.md`（任务状态 / 边界 / 待立项列表）。
2. 归档 `plan.md` / `implementation-summary.md` / `review-report.md` / `test-report.md` / `settlement-report.md` 至 `docs/archive/tasks/<date>-<编号>/`。
3. 机械核对：grep 全仓**非归档区**本任务领域关键词，无"待立项 / 后续 Planning / 未启用 / 未实现 / 暂提示"等过时状态残留（含相邻文档与代码注释）。
4. known-issues 登记：`docs/known-issues.md` 无本任务遗留未登记项（Review 的 P2/P3、Test 失败/未覆盖、Settlement 的"已知保留"必须登记；修复时销号）。
5. git 工作区干净，全部产物已提交。

## 编号与归档

- 任务编号：`D<序号>`。
- 归档目录：`docs/archive/tasks/<YYYY-MM-DD>-D<序号>/`。
- known-issues：`docs/known-issues.md`。

## 流程复盘

- 节奏：每 5 个已结算任务或关键迭代末。
- Settlement 追加复盘节：哪些门有效 / 哪些过重 / 哪类缺陷漏过（对照 known-issues 缺陷类型）。
- 复盘结论 → 更新本文件参数 → 用户确认。
- 撞坑即补：流程漏掉缺陷的事故，修复后把对应检查补进本文件。
