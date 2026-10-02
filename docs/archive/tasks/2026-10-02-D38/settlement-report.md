# D3.8 Settlement — 撤池后不自动重建（2026-10-02）

```yaml
settlement:
  task: D3.8 (product decision, user-confirmed via question flow)
  completion_gate: passed
  decision: 手动 /exit 与风控灾难自动撤池，撤完换 U 后一律停 IDLE；重建仓只能人工 /start。
  rationale: (用户原话) "撤池后，我再运行 /start，不是又开始新一轮了吗" — 手动路径本就是完整闭环;
             风险事件后机器人不自行再进场（宁可资金闲置到人醒来）。
  code_changes:
    - src/execution/actionHandlers.ts /exit 不再调用 approveRebuild/buildPosition（原"post-exit rebuild"删除）
    - src/runtime.ts 风控自动撤池后的自动重选池+建仓块删除
    - ActionHandlerDeps.approveRebuild 与 runtime 的 decideRebuild 接线删除
    - src/strategy/rebuildPolicy.ts 删除（§6.4 自动重建成本上限随之作废）
  invariants: §5.3.2 撤池回纯 U 不变；/start 路径不变（仍是唯一建仓入口）
  docs_updated:
    - docs/decisions/D3-architecture.md（D3.6 表格改 + 新增 D3.8）
    - docs/product/lptrader-product.md（①闭环图⑥、§5.5 风控表、§5.6 重写、§6.1 /exit、§7 验收的换池闭环）
    - docs/product/feature-list.md（8.1 取消、8.2 人工触发、状态图）
    - docs/plan/development-plan.md（T10/T11/T12 🗑️ 取消）
    - PROJECT.md（状态图）
    - docs/OPS.md、docs/USAGE.md（操作描述同步）
  tests: 865/865（/exit 5 旧测试按新语义重写 4 + 删 1；rebuildPolicy 相关删除）
