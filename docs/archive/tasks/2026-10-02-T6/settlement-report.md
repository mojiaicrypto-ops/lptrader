# T6 Settlement Report (2026-10-02)

```yaml
settlement:
  task: T6
  completion_gate: passed
  stable_facts:
    - 撤池全链：remove(decrease+collect+burn 一笔 multicall) → 等落块 → 逐腿换 U(独立幂等键 #convertN) → 等落块 → 纯 U 校验
    - Pancake NFT 7604786 与 Uniswap tokenId 2808516 烧毁（NPM balanceOf 双侧归 0）
    - 钱包收官 USDT 19.548065（起点 19.5531，全程 swap fee 损耗 ≈ $0.03；30% 备用金从未入池）
    - UniswapV3 增加 burn 新支路（零流动性 shell 的 collect+burn），并撤掉一条旧拒绝
    - 尘埃阈值 0.01 → 0.0001 单位（实盘教训：0.0088 QQQB ≈ $6.5 不是尘埃）
    - "legs 在烧毁 NFT 前缓存（exitLegs）—— 第一次实盘暴露:烧毁后 getPosition 返回 null 导致换 U 无从下手"
  updated:
    - docs/product/feature-list.md（4.14 ✅；状态图加撤池 ✅）
    - docs/plan/development-plan.md（T6 标记完成 + 实证验收行）
    - PROJECT.md（撤池 ✅）
    - docs/code-map.md（T5/T6 落地注记）
  evidence_files:
    - docs/research/evidence-live-exit-20261002.txt
  archived:
    - docs/archive/tasks/2026-10-02-T6/settlement-report.md
  proposed_for_confirmation:
    - 换 U 的"U"以 USDT 为准（§10 首选储备）；QQQB/USDC 类池若报价币不是 USDT，报价腿也会被换——是否需要保留部分 USDC？当前默认【全部→USDT】
    - T7（估值/APR）开工前恢复独立评审
