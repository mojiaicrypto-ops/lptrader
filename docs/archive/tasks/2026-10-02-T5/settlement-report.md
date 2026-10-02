# T5 Settlement Report (2026-10-02)

```yaml
settlement:
  task: T5
  completion_gate: passed
  stable_facts:
    - 建仓统一两笔链（swap → 等落块 → 读实际余额 → mint → 等落块）在两个 DEX 上真金通过
    - PancakeSwap 建仓 tokenId 7604786 / Uniswap tokenId 2808516，IncreaseLiquidity 从 receipt 解析
    - 原选 AAPLB 池 TVL $492k 未过 §16（min 500k）—— 过滤器行为正确；改用 合格池 QQQB/USDT 0.01%（$1.07M）
    - 无任何 Uniswap 池过 §16 500k 门槛 → Uniswap 验收使用 config-test（只放低 §16 录入，§40/§41 未动）
    - UniswapV3Adapter 完全没有 approve 逻辑（pancake 侧专有修复未对面）—— 实盘首笔 swap 即 STF，当场修复
    - 30% 备用金核对：建 Pancake 后钱包 19.5531→5.861389，建 Uniswap 后 5.8614→1.759873（NAV×70% 精确一致）
  updated:
    - docs/product/feature-list.md（4.13 ✅；+4.16 实盘脚本；状态图建仓 ⚠️→✅）
    - docs/code-map.md（T5 落地 + pancakeV3/uniswapV3/positionExecutor 注记）
    - docs/plan/development-plan.md（T5 标记完成，验收行更新为实证结果）
    - PROJECT.md（产品状态：建仓 ✅ 双 DEX 实盘验收）
  indexes_updated:
    - docs/research/evidence-live-build-pancake-20261002.txt（新增）
    - docs/research/evidence-live-build-uniswap-20261002.txt（新增，含 config-test 偏差记录）
  archived:
    - docs/archive/tasks/2026-10-02-T5/{plan.md, implementation-summary.md, review-report.md, test-report.md, settlement-report.md}
  disarm_note: config-test/ 已删除（内容记入 Uniswap 证据）
  proposed_for_confirmation:
    - T6（撤池回纯 U）开工前恢复独立评审会话（本任务独立评审未执行，见 review-report）
    - 钱包现有两个 LP 仓位（Pancake/Uniswap 各一），是否需要在下个运行期先撤出以回到纯 U 起点的一致状态（T6 未实现前，手动操作）
  no_change:
    - AGENTS.md — 约束 10–14 未变，本轮为落地验收，无新规则
    - D3 — D3.7 即本轮决策（本任务执行其清理义务，未新增决策）
