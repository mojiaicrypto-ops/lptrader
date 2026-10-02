# T5 全量计划 — 建池按实际余额 + 双 DEX 实盘验收

**状态**：已获用户显式预授权（2026-10-02 会话：实盘操作"中间不必询问"；失败后自主清币重试）。
**产品基线**：§5.3.3（建仓不必精确）、§5.3.5（等待落块）、§5.4（禁止原子建仓，D3.7）。

## 目标与验收

两个 DEX 各跑一次**完整实盘建仓链**，中途失败即停、定位、修、清币重来：

```text
读钱包 U → 算预算(U × max_lp_ratio) → plan → quote → gate
→ swap →【等落块】→ 读实际余额 → addLiquidity(实际值) →【等落块】
```

验收池（已锁定）：
- PancakeSwap V3：`0xe9b9998b2ec5430d2246c7f1f8d9f298c97d7365`（AAPLB/USDT 0.25%，spacing 50）
- Uniswap V3：`0x36c0fc3159eb8662a2e1b84a4df518d916bce0e1`（AAPLB/USDT 0.05%，spacing 10）
- 钱包：`0xb8147e5A1b37dDd51b92A095DC30e44F8BEa8719`，19.553 USDT，BNB ≈ 0.00985

**完成定义**：两个 DEX 各出现 `positionTokenId` 且 `waitForTransaction` 状态 CONFIRMED；单边通过不验收。

## 范围

**内**：
1. `positionExecutor`：`runTwoStepBuild` 重写为唯一路径 —— swap 落块后重读余额，desired0 = 实际持仓（建仓前钱包无股票，§5.3.1），desired1 = clamp(plan.amount1, held1)；minimums 按实际值与预期消耗量重算（L 由 token0 侧决定时 used1 ≈ plan.amount1 × actual0/plan.amount0）；移除 `runAtomicBuild`。
2. `types/adapters.ts`：`AddLiquidityRequest.swapForDeficit` 删除；DexAdapter 增加 `waitForTransaction` / `getTokenBalance`（由 chain 适配器已有能力转发）。
3. `pancakeV3.ts`：删除原子编码支路（`swapAndAddCallParameters`/SmartRouter trade 组装）；保留非原子 mint + `#ensureAllowance` + `#confirm`。
4. `uniswapV3.ts`：删除 `swapForDeficit` 即抛支路。
5. 测试：删除 §42 原子语义测试（AGENTS §6：既有过时行为测试必须删，不重钉）；two-step 测试补 mock（block/receipt/balance/allowance）。
6. 文档：code-map 销号、feature-list 4.13 → ✅、T5 状态、settlement 归档。

**外**：T6（撤池换 U）、T7（估值/APR）、funding 归一化 T8、Uniswap 换 U 的深链路径。

## 实现顺序与角色

| # | 任务 | 文件 |
|---|---|---|
| 1 | 类型与适配器能力 | `types/adapters.ts`、`chain/adapter.ts` |
| 2 | 执行器统一两笔 | `execution/positionExecutor.ts` |
| 3 | Pancake 适配器瘦身 | `dex/pancakeV3.ts` |
| 4 | Uniswap 适配器瘦身 | `dex/uniswapV3.ts` |
| 5 | 测试修复/删除 | `tests/**` |
| 6 | 实盘验证 | 实盘脚本（一次性，验后删） |
| 7 | 文档结算 | `docs/**` |

## 关键设计决定

- **余额读取归属执行器**（不是适配器）：执行器拥有编排时序，适配器保持"收到什么建什么"的纯粹性；chain 能力经 DexAdapter 转发以避免执行器直接依赖 chain 具体类。
- **desired1 用计划值 clamp**，不用全部钱包 USDT：30% 备用金必须保留（§5.3.1 状态图"钱包备用金"）；多余部分由合约自动退还（NPM mint 语义）。
- **min0 = actual0 × r0；min1 = used1Est × r1**（r 来自已批准意图的容差比例）；不用 desired1 × r1 —— 当 token0 侧决定 L 时 used1 < desired1，会误触发滑点检查。

## 风险与止损

- **滑点容差边界**：swap 实得 Σ/planned0 必须 > r1；0.25%/0.05% 两个费率 + 4~5U 规模实测余量充足；失败则记录实测值回 Developing。
- **gas 耗尽**：BNB 0.00985 ≈ 10 笔；两 DEX 各 2~3 笔（approve+swap+mint，approve 常可复用 allowance）够用；不足则报阻。
- **UNKNOWN 状态**：一律 `DO NOTHING` + 查链，禁止自动重发（§98）。
- **回滚**：全部改动无迁移、无状态变更；git revert 即回滚。实盘仓位可通过撤池退出。

## 验证命令与证据

```text
npx tsc --noEmit                       # 0 error
npx vitest run                         # 全量，记录失败处置
实盘：脚本输出（余额、预算、quote、gate、各 txHash、落块状态、tokenId）
证据文件：docs/research/evidence-live-build-<dex>-20261002.txt
```
