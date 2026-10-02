# T5 Implementation Summary (2026-10-02)

## Goal
建仓统一两笔链（swap → 确认 → 读实际余额 → mint → 确认），双 DEX 实盘验收（§5.3.3/§5.3.5/D3.7）。

## Changed paths
| 文件 | 变更 |
|---|---|
| `src/types/adapters.ts` | DexAdapter + `getTokenBalance`；删除 `AtomicSwapForDeficit` 与 `AddLiquidityRequest.swapForDeficit`；`supportsAtomicBuild` 注释改为"仅描述部署能力，执行器不再分叉" |
| `src/chain/adapter.ts` | + `getReceiptLogs`（原始 receipt logs，供 tokenId 解析） |
| `src/execution/positionExecutor.ts` | 删除 `runAtomicBuild`；`runTwoStepBuild` 为唯一路径：swap（适配器内已确认）→ 重读钱包（§5.3.3）→ desired0=全额持仓、desired1=clamp(plan.amount1, held1) 保住 30% 备用金 → minimums 按实际值重算（r 取自已批准意图；token0 决定 L 时 used1≈plan.amount1×actual0/plan.amount0）→ mint → recordSubmitted；+ `POST_SWAP_SHORTFALL` 拒绝类型 |
| `src/dex/pancakeV3.ts` | 删除 §42 原子编码支路（~350 行：SDK bridging、SmartRouter trade、#atomicDeadline）；`executeSwap`/`addLiquidity` 内 #confirm（§5.3.5）；`#mintedTokenId`（IncreaseLiquidity topic 比对）；`#send` 统一记录 calldata |
| `src/dex/uniswapV3.ts` | + `ensureAllowance`（exact；BSC-USDT zero-then-max；每笔 approve 等确认）—— **此前完全没有 approve 逻辑**；`executeSwap`/`addLiquidity` 确认 + tokenId 解析 |
| `src/main.ts` | `resolveSigner` 导出（脚本复用） |
| `scripts/live-build.ts` | 新增：生产路径实盘验收脚本（scan→§16→orchestrator→funding→executor→链上复核），支持 `--dex/--pool/--config-dir` 与 `LIVE_PRIVATE_KEY`（仅测试钱包） |
| `tests/**` | 删除全部 §42 原子语义测试（AGENTS §6）；two-step 语义测试重写；pancake/uniswap mock 服务 receipt/block/allowance/tokenId |

## Deviations & discoveries
1. **批准流契约**：notifier 只返回决定，gate 持久化（settle）。脚本 stub 曾直接 decide 造成双重判定 → 记录为 REJECTED；修正后正常。
2. **Uniswap 无 approve**：实盘首笔 swap 即 STF —— 当场补 `ensureAllowance`。验证了"验收只能是真实资金链路"的纪律。
3. **池子选择**：AAPLB/Pancake 池 TVL $492k 未过 §16 500k 门槛（过滤器行为正确）；无任何 Uniswap 池过门槛。实盘 Pancake 改用合格的 QQQB/USDT 0.01%；Uniswap 用 config-test（仅放低 §16 录入门槛，§40/§41 执行门槛未动）。
4. 建池金额即 swap 后实际余额；残留核对：Pancake 后 5.861389 / Uniswap 后 1.759873，与"预算=NAV×70%"精确一致。

## Unresolved
- 独立 Review 与全量测试报告由同一会话执行（子代理配额 429）—— settlement 记录为已接受风险；后续任务应补独立评审。
- T6（撤池回纯 U）、T7（估值/APR）未动。
