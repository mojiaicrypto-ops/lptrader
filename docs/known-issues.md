# Known Issues

按严重度登记：`P1` 阻断 / `P2` 重要 / `P3` 次要。修复后销号并保留一行修复记录。

| ID | 严重度 | 状态 | 描述 | 来源 | 关联 |
|---|---|---|---|---|---|
| KI-1 | P1 | open | **L3 硬门禁未纳入真实资金操作**：`AGENTS.md` 的 L3 关键词含 `swap`/`sendTransaction`，但"主网真实资金执行"仅由 Plan 确认段的规则约束，未做机械拦截（无 dry-run 强制、无金额上限校验）。 | Onboarding 决策 D1 | AGENTS.md / 执行层 |

## 已登记待处理（Onboarding 阶段产生）

> 以下为待 Phase 3 实现前必须收敛的**已知缺口**，不是缺陷：
> - 参考价（Reference NAV）来源未定：闭市期间 `Alternative Reference Pricing`（§57）需在实现前确认可用 source，否则按基线"Disable Hard Depeg Exit，仅报警"。
> - 池子历史数据源（7D/30D volume 序列、池创建时间）未定：决定 VolumeStabilityScore 与 `min_pool_age_days` 是否可计算，缺则须降级为已知限制。
> - 股票代币官方合约地址未落库：白名单为空的系统**不得**执行任何建仓（Fail Closed）。
