# PROJECT — lptrader

**一句话**：一个自动管理股票代币集中流动性（LP）仓位的资产管理系统，以风险控制为第一优先级。

## 定位

不是追逐最高 APR 的 Yield Farming Bot，而是**以风险控制为第一优先级的股票代币 LP 自动资产管理系统**。人是监督者，不是操作者。

## 产品状态

**当前：建仓 + 撤池(换U) + 估值/APR 均已通过真实资金验收（2026-10-02，T5/T6/T7）。** 2026-10-01 首次实盘暴露四类 dry-run 无法发现的缺陷（签名账户形态、缺少 `approve`、授权未等落块、建池用计划值），2026-10-02 修复并双 DEX 跑通完整实盘（PancakeSwap tokenId 7604786；Uniswap tokenId 2808516 —— 后者还暴露并修复了 Uniswap 侧完全没有 approve 逻辑的缺陷）。
**追加（同日，T6/T7）**：撤池自动换 U（两腿+fee，NFT 烧毁）与 §4.2.1 估值+APR 均已实盘验收；钱包收官纯 U 19.546855。

```text
发现池 ✅ ──→ 筛选 ✅ ──→ 建仓 ✅ ──→ 监控 ⚠️ ──→ 撤池 ✅ ──→ 风控判定 ✅
                             │                        │
                             └── 查询 ❌               ↓
                                              撤池 ✅（回纯 U 停 IDLE）
                                                    │
                                              ↓ /start（人工，D3.8）
                                              重新建仓 ✅
```

| 环节 | 状态 | 缺口 |
|---|---|---|
| 建仓 | ✅ 双 DEX 实盘验收 | — |
| 监控 | ✅ 估值+APR 口径实盘打通（§4.2.1，T7） | — |
| 撤池 | ✅ 双 DEX 实盘验收（§5.3.2：两腿+fee 换 U + 烧 NFT） | — |

**验收纪律**：`npm test` 与 dry-run **不代表产品可用**。4.10–4.13 四类缺陷均通过真实资金链路才暴露。**建仓的验收标准是一次完整的实盘链路**：授权 → 等落块 → swap → 等落块 → 建池 → 等落块，中途不得停。

**详细逐条状态**：[`docs/product/feature-list.md`](docs/product/feature-list.md)
**待开发项与顺序**：[`docs/plan/development-plan.md`](docs/plan/development-plan.md)

## 环境

| 项 | 值 |
|---|---|
| 技术栈 | TypeScript / Node（viem + PancakeSwap V3 SDK） |
| 链 | BNB Chain（chainId 56） |
| DEX | PancakeSwap V3、Uniswap V3（建仓统一两笔，D3.7） |
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
