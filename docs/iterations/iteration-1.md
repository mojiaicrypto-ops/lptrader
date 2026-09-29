# Iteration 1 — 单池实盘（Phase 3）

**状态**：Planning
**对应产品基线**：`docs/product/stock-lp-auto-strategy-v1.md` §109 Phase 3

## 范围

只允许 **QQQB / USDC**（BNB Chain，PancakeSwap V3）单池，实现：

```text
Build Position → Monitor → Exit
```

具体能力（来自基线 §1 自动任务清单中 Phase 3 可达子集）：

- 账户资产监控（钱包余额、资金存量）→ §5
- 池子扫描与硬性过滤（单池适配，Scanner 结构按多池设计）→ §14–§16
- 建仓比例计算（集中流动性数学，反推 `L`）→ §33–§38
- Stablecoin → 股票代币 swap + Add Liquidity 建仓 → §39–§43
- LP 收益持续监控、区间监控、脱锚监控 → §46–§59
- 全局风险控制（回撤线、TVL 崩溃、Emergency）→ §58–§67
- 仓位退出（含 `GLOBAL_RISK_OFF` 触发路径）→ §67、§88
- 决策日志与持久化 → §74–§77
- 告警 → §78

## 非目标（本迭代明确不做）

```text
自动换池 / Pool Ranking 决策（Phase 5）
多池选择（Phase 4）
多链 / 多 DEX（Phase 6）
Backtest 引擎（§101，独立于实盘，另立迭代）
自动复投 compound（基线恒为 false）
```

## 迭代约束

- 密钥：启动输入 passphrase → AES-256-GCM 加密私钥落盘（用户决策，见 `AGENTS.md` 密钥管理）。
- 实盘签名钱包必须独立；本迭代所有写操作先走 testnet 或 dry-run，再经用户显式确认才可主网执行。
- 白名单为空时系统必须拒绝建仓（Fail Closed）。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 股票代币官方合约地址/池不存在或流动性不足 | 无可用池，实盘无法启动 | Onboarding 调研确认；无池则退回 Phase 1 监控模式 |
| PancakeSwap V3 无官方 TS SDK / 与 Uniswap V3 SDK 不兼容 | 建仓数学或路由需自实现 | 调研结论决定是否手写 tick math 与 calldata |
| 参考 NAV 在闭市期间不可靠 | 误判脱锚 → 错误平仓 | 按 §57 降级为仅报警 |
| 无历史 volume 数据 | VolumeStabilityScore 不可算 | 降级为已知限制并登记 |
