# T5 Review Report (2026-10-02) — self-review, with the independence gap declared

独立评审未按流程执行（子代理配额 429，无法另开会话）。以下为同一会话内的自查结果，
已接受的余险记入 settlement。后续任务（T6）开工前应恢复独立评审。

## Blocking findings: none remaining
- runAtomicBuild / swapForDeficit 的全部调用点、类型、测试、文档均已切除（grep 归零）。
- executeSwap/addLiquidity 的确认语义：适配器等落块并抛不一致状态；执行器据 CONFIRMED 读余额。
- 最小值重算：r 从已批准意图推导；token0 侧决定 L 时 used1 估计显式 clamp。
- 30% 备用金：desired1 = min(plan.amount1, held1)，pos 核对（5.861/1.760 与净值差精确一致）。

## Non-blocking
1. `supportsAtomicBuild` 标志仍在接口上（D3.7 允许保留；无代码分叉）。
2. `scripts/live-build.ts` 的 LIVE_PRIVATE_KEY 仅存在于脚本层，src/ 的 keystore 铁律未动。
3. uniswapV3 的 `awaitMined` 与 pancakeV3 的 `#confirm` 重复同一语义 —— 可日后抽公共层（boring > clever，暂不抽）。
