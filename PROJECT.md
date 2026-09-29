# PROJECT — lptrader

**一句话**：Stock LP Auto Strategy 是一个自动寻找高质量股票代币流动性池，并根据集中流动性数学进行最优资金配置，在严格控制脱锚、无常损失、滑点、池子质量和账户回撤的情况下获取 LP 手续费收益的自动资产管理系统。

## 定位

不是追逐最高 APR 的 Yield Farming Bot，而是**以风险控制为第一优先级的股票代币 LP 自动资产管理系统**。

## 当前状态

| 项 | 值 |
|---|---|
| 迭代 | Iteration 1 — 单池实盘（Phase 3） |
| 阶段 | Onboarding / Planning |
| 技术栈 | TypeScript / Node |
| 链 | BNB Chain（chainId 56） |
| DEX | PancakeSwap V3（白名单另含 Uniswap V3） |
| 首期标的 | QQQB / USDC |
| 初始资金示例 | 10,000 USDC（LP 上限 70%，Reserve 30%） |

## 范围（Iteration 1）

**做**：账户/仓位/未领取 fee 读取、NAV 计算、池子扫描与硬性过滤、集中流动性建仓数学（optimal ratio）、swap + addLiquidity 建仓、区间与脱锚监控、风控（脱锚分级 / 全局回撤 / TVL 崩溃）、仓位退出、决策日志、SQLite 持久化、告警。

**不做（V1 明确排除）**：高频交易、股价预测、AI 方向预测、杠杆、借贷、Delta Neutral、Futures Hedge、高频 Rebalance、自动追涨、自动补仓、无限制 Compound、未授权 Token 自动发现、自动换池（Phase 5）、多池（Phase 4）、多链（Phase 6）。

## 文档导航

| 文档 | 作用 |
|---|---|
| [docs/product/stock-lp-auto-strategy-v1.md](docs/product/stock-lp-auto-strategy-v1.md) | **产品基线**（canonical 事实来源） |
| [AGENTS.md](AGENTS.md) | 项目级执行参数与硬性约束 |
| [docs/document-index.md](docs/document-index.md) | 文档索引 |
| [docs/code-map.md](docs/code-map.md) | 代码地图 |
| [docs/known-issues.md](docs/known-issues.md) | 遗留问题登记 |
| [docs/iterations/iteration-1.md](docs/iterations/iteration-1.md) | 当前迭代范围与状态 |
| [docs/archive/tasks/](docs/archive/tasks/) | 任务归档（Plan / Review / Test / Settlement） |

## 核心原则（详见产品基线 §2、§112）

```text
Safety > Yield
Risk Filter > Pool Ranking
Net APR > Frontend APR
NAV > Wallet Balance
Contract Address > Token Symbol
Optimal LP Ratio > Fixed 50/50
Hold > Frequent Rebalance
Stable Yield > APR Chasing
Fail Closed > Guess And Trade
```
