# PROJECT — lptrader

**一句话**：Stock LP Auto Strategy 是一个自动寻找高质量股票代币流动性池，并根据集中流动性数学进行最优资金配置，在严格控制脱锚、无常损失、滑点、池子质量和账户回撤的情况下获取 LP 手续费收益的自动资产管理系统。

## 定位

不是追逐最高 APR 的 Yield Farming Bot，而是**以风险控制为第一优先级的股票代币 LP 自动资产管理系统**。

## 当前状态

| 项 | 值 |
|---|---|
| 迭代 | Iteration 1 — 单池实盘（Phase 3） |
| 阶段 | **Settling**（Plan 批准 → Develop → 独立 Review → Test 均已完成；Plan: `docs/archive/tasks/2026-09-29-D2/plan.md`） |
| 技术栈 | TypeScript / Node（viem 2.37.13 + PancakeSwap 官方 V3 SDK） |
| 链 | BNB Chain（chainId 56） |
| DEX | PancakeSwap V3 + Uniswap V3（白名单） |
| 首期标的 | QQQB ×（USDC/USDT），池由 Scanner 自动发现 |
| 初始资金示例 | 10,000 USDC（LP 上限 70%，Reserve 30%） |
| 代码 | 已实现（49 源文件 / 25 测试文件 / 6 脚本）；`npm run typecheck` 0 错误，`npm test` **701 测试全绿** |

## 范围（Iteration 1）

**做**：账户/仓位/未领取 fee 读取、NAV 计算、池子扫描与硬性过滤、集中流动性建仓数学（optimal ratio）、swap + addLiquidity 建仓、区间与脱锚监控、风控（脱锚分级 / 全局回撤 / TVL 崩溃）、仓位退出、决策日志、SQLite 持久化、告警。

**不做（V1 明确排除）**：高频交易、股价预测、AI 方向预测、杠杆、借贷、Delta Neutral、Futures Hedge、高频 Rebalance、自动追涨、自动补仓、无限制 Compound、未授权 Token 自动发现、自动换池（Phase 5）、多池（Phase 4）、多链（Phase 6）。

## 文档导航

| 文档 | 作用 |
|---|---|
| [docs/iterations/iteration-1-acceptance.md](docs/iterations/iteration-1-acceptance.md) | §108 验收项 → 实现 → 可复现证据 → 状态 |
| [docs/product/stock-lp-auto-strategy-v1.md](docs/product/stock-lp-auto-strategy-v1.md) | **产品基线**（canonical 事实来源） |
| [AGENTS.md](AGENTS.md) | 项目级执行参数与硬性约束 |
| [docs/document-index.md](docs/document-index.md) | 文档索引 |
| [docs/code-map.md](docs/code-map.md) | 代码地图 |
| [docs/known-issues.md](docs/known-issues.md) | 遗留问题登记 |
| [docs/iterations/iteration-1.md](docs/iterations/iteration-1.md) | 当前迭代范围与状态 |
| [docs/archive/tasks/](docs/archive/tasks/) | 任务归档（Plan / Review / Test / Settlement） |

## 运行入口

```bash
npm run typecheck          # 0 错误
npm test                   # 690 测试
npm run dev                # 配置/白名单自检（只读，不连链）
npm run smoke:read         # 链上只读：池状态 / 余额 / uiMultiplier
npm run smoke:scan         # 真实三层扫描 + §16 过滤（约 4 分钟）
npm run smoke:quote        # 真实 QuoterV2 报价 + §40 闸门
npm run dry-run:build -- 7000   # 完整建仓决策链，不签名不发送
npm run keystore:init      # 生成加密私钥（0600）
npm run telegram:check     # Telegram 通道 fail-closed 自检
```

## 已完成的验证（证据可复现）

| 阶段 | 结果 | 证据 |
|---|---|---|
| Plan | 已批准（含用户裁定 D3/D4/C1/C3） | `docs/archive/tasks/2026-09-29-D2/plan.md` |
| Develop | 完成 | `implementation-summary.md` |
| 独立 Review（L3） | **发现 4 个 blocking，全部已修复并回归** | `review-report.md` |
| 独立 Test | passed | `test-report.md` |
| 链上只读 | 8 个 bStock `uiMultiplier()` 实测 + 换算与合约 MATCH | `docs/research/evidence-smoke-read-20260929.txt` |
| 池扫描 + §16 | `complete=true`，2 池通过，0 blocker | `docs/research/evidence-smoke-scan-20260929-t6.txt` |
| 报价 | 1000 USDT → 1.353115 QQQB，impact 0.0123% | `npm run smoke:quote` |
| **dry-run 建仓** | 价值总和 4900.00 精确、tick 对齐、§35 反证 4.38%、impact 独立复算 exact、原子单笔 | `docs/research/evidence-dry-run-build-20260929.txt` |

## 当前可执行性（实测，2026-09-29）

真实扫描下**通过 §16 硬性过滤的池只有 2 个**（均为 PancakeSwap V3）：QQQB/USDT（fee 100，TVL ~$620k）与 AAPLB/USDT（fee 2500，TVL ~$540k）。
此前记录的 QQQB/USDC @ Uniswap V3 **被淘汰**，唯一原因是 `$3500 换手价格影响 0.66% > 0.5%` 门槛 —— 即该池在 §110 的 $7,000 规模下深度不足。
结论：**在 §110 资金规模下可执行的 QQQB 池只有 PancakeSwap V3 的 QQQB/USDT**（它同时是唯一支持 §42 原子建仓的 DEX）。详见 `docs/research/evidence-pool-scanner-filter-20260929.md`。

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
