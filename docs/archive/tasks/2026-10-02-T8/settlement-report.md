# T8 Settlement Report (2026-10-02)

```yaml
settlement:
  task: T8
  completion_gate: passed
  stable_facts:
    - 建仓前纯 U 校验落在 funding.plan() 最前，一次 multicall3 批读 registry 白名单股票余额 + 两个 NPM NFT 计数
    - 实盘负例：真金残留（QQQB 1338）→ WALLET_NOT_PURE_U 正式拒绝，拒信含精确余额与"上次退出不完整"归因
    - 恢复链路同样走 §5.3.2：全量残留卖出（不适用尘埃规则于清理口径）
    - 未知代币不校验（无 indexer 无法枚举；§8/§12 本就拒绝读它——不是"退出不完整"证据）
  updated:
    - docs/plan/development-plan.md（T8 完成行）
    - docs/product/feature-list.md（+4.17）
    - docs/code-map.md（FundingPlanner 注记）
  evidence_files:
    - docs/research/evidence-funding-gate-20261002.txt
  archived:
    - docs/archive/tasks/2026-10-02-T8/settlement-report.md
  proposed_for_confirmation:
    - 非 U 的报价腿稳定币（如 USDC 池）是否也算"残留"拒绝建仓——当前实现【算】（§10 视角）；若要放宽为"报价腿可豁免"需用户确认
