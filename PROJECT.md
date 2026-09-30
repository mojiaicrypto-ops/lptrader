# PROJECT — lptrader

**一句话**：一个自动管理股票代币集中流动性（LP）仓位的资产管理系统，以风险控制为第一优先级。

## 定位

不是追逐最高 APR 的 Yield Farming Bot，而是**以风险控制为第一优先级的股票代币 LP 自动资产管理系统**。人是监督者，不是操作者。

## 产品状态

**当前：闭环未完成。** 系统能发现、筛选、监控、判定风险，但**不能建仓** —— 因此无法开始一笔交易。

```text
发现池 ✅ ──→ 筛选 ✅ ──→ 建仓 ❌ ──→ 监控 ✅ ──→ 风控判定 ✅
                             │                        │
                             └── 查询 ❌               ↓
                                              撤池 ✅（仅灾难级自动）
                                                    │
                                              重新选池 ❌ ──→ 重新建仓 ❌
```

**详细逐条状态**：[`docs/product/feature-list.md`](docs/product/feature-list.md)
**待开发项与顺序**：[`docs/plan/development-plan.md`](docs/plan/development-plan.md)

## 环境

| 项 | 值 |
|---|---|
| 技术栈 | TypeScript / Node（viem + PancakeSwap V3 SDK） |
| 链 | BNB Chain（chainId 56） |
| DEX | PancakeSwap V3（§42 原子建仓）、Uniswap V3 |
| 首期标的 | 8 个 bStock ×（USDC/USDT），池由 Scanner 自动发现 |
| 存储 | SQLite |

## 文档导航

| 文档 | 作用 |
|---|---|
| [`docs/product/lptrader-product.md`](docs/product/lptrader-product.md) | **产品文档（唯一权威）**：产品是什么、闭环、规则、验收 |
| [`docs/product/feature-list.md`](docs/product/feature-list.md) | **功能列表**：逐条功能 + 真实状态 + 验证方式 |
| [`docs/plan/development-plan.md`](docs/plan/development-plan.md) | **开发计划**：按 dry-run 端到端验收 |
| [`docs/product/stock-lp-auto-strategy-v1.md`](docs/product/stock-lp-auto-strategy-v1.md) | 规则条款细节（**参考，非权威**） |
| [`docs/decisions/`](docs/decisions/) | 技术决策记录（D1 范围/技术栈、D2 执行授权） |
| [`docs/OPS.md`](docs/OPS.md) | 部署与运维 |
| [`docs/USAGE.md`](docs/USAGE.md) | 日常操作 |
| [`docs/known-issues.md`](docs/known-issues.md) | 已知问题 |
| [`docs/code-map.md`](docs/code-map.md) | 代码地图 |
| [`docs/document-index.md`](docs/document-index.md) | 文档索引 |
| [`AGENTS.md`](AGENTS.md) | 项目级执行参数与硬性约束 |
| [`docs/archive/`](docs/archive/) | 历史任务归档 |

## 运行入口

```bash
npm run typecheck          # 类型检查
npm test                   # 单元测试（组件级，不代表产品可用）
npm run dev                # 真实入口：启动调度器
npm run smoke:read         # 链上只读：池状态 / 余额 / uiMultiplier
npm run smoke:scan         # 真实三层扫描 + §16 过滤（约 4 分钟）
npm run smoke:quote        # 真实 QuoterV2 报价
npm run dry-run:build -- 7000   # 建仓决策链预演（不签名不广播）
npm run keystore:init      # 生成加密私钥（0600）
npm run telegram:check     # Telegram 通道 fail-closed 自检
```

## 核心原则

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

## 验收纪律

**"代码存在 + 测试通过" 不构成完成。** 完成 = 真实入口运行时，功能走到「待广播交易已构造」或「明确的拒绝原因」。

理由：本项目的多次失误都源于把"函数写完且有测试"当成"功能存在"。**测试全绿而功能不存在，是可能的** —— 已发生过。
