# Iteration 1 验收映射（§108 → 实现 → 证据）

> §108 的每一条必须在 **Test 阶段以运行证据** 关闭，不以"代码写了"替代。
> 状态列：`pending` / `passed` / `not-covered`（须登记 known-issues）/ `blocked`。

| §108 分组 | 验收项 | 实现位置 | 证据形式 | 状态 |
|---|---|---|---|---|
| Portfolio | 正确读取钱包余额 | T4/T5 | 只读冒烟脚本输出 vs 链上/浏览器 | pending |
| Portfolio | 正确读取 LP Position | T5 | 只读冒烟：`positions(tokenId)` + `balanceOf` | pending |
| Portfolio | 正确读取未领取 Fee | T5 | 只读冒烟：`positions()` 的 tokensOwed | pending |
| Portfolio | 正确计算 NAV | T12 | 单测 + 冒烟：总和 = 钱包 + LP 估值 + 未领取 fee + realized | pending |
| Portfolio | 正确计算 Reserve Ratio | T12 | 单测（边界：恰好 30% / 25% / 20%） | pending |
| Pool Scanner | 正确读取池 TVL | T6 | 三层数据源交叉 + RPC reserve 校验 | pending |
| Pool Scanner | 正确读取 24h Volume | T6 | GeckoTerminal 实测 | pending |
| Pool Scanner | 正确读取 7D Volume | T6 | DexPaprika `volume_usd_7d` | pending |
| Pool Scanner | 正确读取 Fee Tier | T6 | RPC `fee()` 为真值（DexPaprika `fee` 为 null） | pending |
| Pool Scanner | 正确读取 Active Liquidity | T5/T6 | RPC `liquidity()`（无免费 API 可替代） | pending |
| Pool Filter | TVL / Volume / Token 白名单 / Stablecoin 白名单 / DEX 白名单 / NAV Deviation | T6 | 单测：各过滤器单独 + 组合；边界值（== 阈值） | pending |
| Position Planning | 正确计算 Upper / Lower | T8 | 单测：`×0.85 / ×1.16` 精确值 | pending |
| Position Planning | Tick 对齐 | T8 | 单测：非对齐输入 → 对齐到 `tickSpacing` 整数倍；断言 `Position` 不抛 | pending |
| Position Planning | 正确计算 Token0 / Token1 Optimal Ratio | T8 | 单测：与 Pancake SDK `Position.fromAmounts` 交叉对账（同输入同输出） | pending |
| Position Planning | 正确计算 Swap Amount | T8 | 单测：**反例断言** —— 固定 50/50 会偏离最优（证明不采用 §35 错误方案） | pending |
| Swap | Quote | T9 | QuoterV2 只读调用 | pending |
| Swap | Slippage Check | T9 | 单测：超 0.3% 拒绝 | pending |
| Swap | Price Impact Check | T9 | 单测：超 0.5% 拒绝建仓；超 1% 标记 Liquidity Risk | pending |
| Swap | Deadline | T9 | calldata 含 deadline/previousBlockhash 断言 | pending |
| Swap | Balance Verification | T9 | 单测 + 冒烟：swap 前后余额差 == amountOut | pending |
| LP | Add Liquidity / Position Verification | T9 | dry-run calldata 断言 + 主网确认后链上验证 | pending |
| LP | Collect Fee | T9 | 单测条件触发（≥$100 或 30 天） | pending |
| LP | Remove Liquidity | T9 | dry-run calldata 断言 | pending |
| Risk | Peg Warning | T10 | 单测：0.99/1.01/1.02/1.03/1.05 边界五档 | pending |
| Risk | Global Drawdown | T10 | 单测：NAV 恰好 = 85% 时触发（含 `<=` 边界） | pending |
| Risk | TVL Collapse | T10 | 单测：50% / 70% 两级 | pending |
| Risk | Out Of Range | T10 | 单测：`price >= upper` / `price <= lower` / 边界相等 | pending |
| Risk | Emergency Pause | T10 | 单测：8 类 emergency 条件各触发 | pending |
| Switching | Detect Underperformance | — | **out of scope（Phase 5）** → known-issues | pending |
| Switching | Search Alternative / Compare APR / Calculate Switching Cost / Break Even Days / Cooldown Enforcement | T13 的门 + T10 | **部分**：确认门与 cooldown 状态存储在本迭代；换池决策逻辑属 Phase 5 | pending |
| （补充）| Telegram 确认门 fail-closed（无 token → 不建仓） | T13 | 单测 | pending |
| （补充）| 密钥：错误 passphrase 硬失败、密文不落日志 | T3 | 单测 | pending |
| （补充）| 交易状态 UNKNOWN 不自动重发 | T11 | 单测：UNKNOWN 状态下 re-execute 被拒 | pending |

## 说明

- **Switching 组**在 §108 中要求完整换池能力，但用户在 D1 选择 Iteration 1 = Phase 3（单池），自动换池属基线 Phase 5。本迭代只交付 **确认门 + cooldown 存储**，不交付换池决策。这是**经用户确认的范围裁剪**（D1 表格第 3 行），不是静默缩小。剩余条目已登记 `docs/known-issues.md`。
