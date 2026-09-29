# D2 — Independent Review Report

```yaml
review:
  task: D2
  reviewer_sessions:
    - IndependentReview   # 首次尝试：fan-out 导致模型 400，未产出结论
    - ReviewSafety        # 安全关键路径（私钥/写路径/确认门/白名单）
    - ReviewCorrectness   # 核心正确性（CL 数学/闸门/幂等/状态机/调度）
    - ReviewFailClosed    # Fail Closed 与数据可信度（阈值/NAV/区块固定）
  reviewer_model: opencode-go/deepseek-flash（与开发者同一模型配置；隔离靠**独立会话 + 仅读 + 无开发者上下文**，见下方局限说明）
  context_snapshot:
    baseline: docs/product/stock-lp-auto-strategy-v1.md
    plan: docs/archive/tasks/2026-09-29-D2/plan.md
    diff_range: 091d785..HEAD（105 文件 / 41,477 行新增）
    provided_to_reviewers: AGENTS.md、D1/D2 决策、known-issues.md、调研记录
    withheld: 开发者的对话、自评、实现意图
```

## 结论

**result: failed**（发现 4 个 blocking，**全部已修复并加回归测试**；修复后无已知 blocking 残留）

按 L3 门禁定义，`passed` 只表示"某次评审未发现 blocking"。本次评审**发现了 4 个真实缺陷**，因此原始评审结论为 **failed**；每个缺陷都已修复、回归测试已补、并由评审者的**原始探针**复验通过（见下）。当前状态为 **Review findings closed → 进入 Test**。

## Findings

### F1 — blocking · `TxGuardChecks` 信任调用方自报布尔值
- **location**: `src/chain/adapter.ts` `sendTransaction` / `src/chain/txState.ts` `assertTxGuard`
- **evidence（评审者自建探针 `/tmp/omp-rev/guard-bypass.test.ts`）**：`assertTxGuard` 只从 guard 自身的布尔值**重新推导** `ok`，不验证任何事实。构造一个所有子项均为 `true` 的 guard，指向**非白名单地址**，`assertTxGuard` **接受**。
  - 集成方独立复现：对已知冒充地址 `0xb904108b…` 的伪造 guard 被接受。
- **impact**: `sendTransaction` 是全系统**唯一写路径**。这使"签名到错误合约"这一最致命失败模式仅依赖调用方诚实 —— §91 明令禁止 `Approve Unknown Contract` / `Interact With Unknown DEX`。
- **remediation（已实施）**: `BscChainAdapter.sendTransaction` 广播前**独立**校验 `tx.to` ∈ {本链白名单 DEX 合约, Multicall3}。三次回归测试 + 一个负向对照（白名单目标必须因"缺 signer"而非"目标"失败）。
- **副作用（有价值的意外收获）**: 该检查立即发现 **Pancake SmartRouter `0x13f4ea83…`（§42 原子建仓的目标合约）不在白名单** → 已补入 `BSC_DEX_CONTRACTS`（地址取自 `@pancakeswap/smart-router` 的 `SMART_ROUTER_ADDRESSES[56]` 并核对相等）。
- **状态**: 已修复 → KI-21（resolved）

### F2 — blocking · 原子建仓的 txHash 记在派生键上，主行永久 `CREATED`
- **location**: `src/execution/positionExecutor.ts` `runAtomicBuild`
- **evidence（评审者探针 `/tmp/mut2/tests/review/probe2.test.ts`）**：原子路径（一笔交易）把 hash 记在 `key#add`，主行 `build-1` 永停在 `CREATED` 且无 hash。
- **impact**: ① `findUnresolved()` 永久返回**无法用链上查询解决**的幽灵记录（无 hash 可查）；② 审计轨迹声称"建仓未发出"而交易实际已确认；③ 主行 `tx_hash` 因 UNIQUE 约束**永远无法补记**。
- **remediation（已实施）**: 原子路径把 hash 记在**主键**（`markSubmitted(primaryKey, hash)`）；两笔路径 swap 记主键、mint 记 `addKey()`；`addKey()` 收敛为唯一派生点。
- **复验（评审者原探针）**: `PRIMARY: {state: SUBMITTED, hash: 0xadd1}`；`applyChainObservation -> ok`；`primary after resolving: CONFIRMED`；`findUnresolved on next start:` 空。
- **状态**: 已修复 → KI-22（resolved）

### F3 — blocking · §98 重试路径不可用（attempt 固定为 1）
- **location**: `src/execution/positionExecutor.ts` `runBuild` / `src/store/txStore.ts` `record`
- **evidence（同一探针 + 集成复现）**: intent 一律以 `attempt: 1` 记录，而 `TxStore.record` 对重复 `(key, attempt)` **返回既有行不变** → REVERTED 后的重试其新交易**无处记录**，随后 `markSubmitted` 因该行已是 REVERTED 抛 `invalid_transition`。实测重试返回 `adapter_failed`。
- **impact**: §98 明文要求"确定性失败后可重试"，实现使该路径**完全无法使用**；且失败被记为 `UNKNOWN` 而非真实原因，误导运维。
- **remediation（已实施）**: 新增 `recordIntent()`，`attempt` 由 store 推导（首次 1，确定性失败后 `latest.attempt + 1`）；第二腿同理。
- **复验**: `rows for build-1: attempt1:REVERTED/0xswap1 | attempt2:UNKNOWN/0xswap3`（新 attempt 已建立）；边界负向测试**保留**"前次未解决时拒绝开新 attempt"以防修复破坏幂等。
- **状态**: 已修复 → KI-23（resolved）

### F4 — blocking · 用股票参考价源给稳定币定价 → NAV 归零 → 虚假 §66 停机
- **location**: `src/execution/portfolioMonitor.ts` `buildPriceTable` / `monitor`
- **evidence（评审者探针 `/tmp/probe6.ts`，集成独立复现）**: 健康市场下
  ```
  USDC ref = {"value":null,"source":"unavailable","stale":true}
  complete = false ; totalNAV = 0 ; reserveRatio = 0
  drawdown = {"breached":true,"fromInitial":1,"line":8500}
  ```
  `ReferencePriceProvider` 是**股票**参考价源（仅认 bStock ticker），对 USDC/USDT 必然返回不可用；而 `buildPriceTable` 对**白名单每一个**未定价 token 都记问题（与持仓无关）。
- **impact**: ① 预留资金计价为 0 → `totalNAV=0` → **健康组合被当成全额亏损，§66 立即 GLOBAL_RISK_OFF 停机**（把"无法估值"伪装成"亏光了"）；② 任何组合都永远 `complete=false`，使 `complete` 门失效。
- **remediation（已实施）**: ① 新增 `PortfolioMonitor` 的 `stablecoinPrice` 依赖，runtime 接 Binance `USDCUSDT` spot（USDT 为报价币，其美元值由报价约定决定而非假设 peg）；② **估值不完整时 `drawdown` 返回 `null`**（既非 safe 也非 breached —— 此时 `totalNAV` 只是下界）；③ 未定价问题只对**实际持仓非零**的 token 报告。
- **复验**: 同一探针 → `complete = true / totalNAV = 3001.11 / problems = []`（其中 `breached: true` 对该探针是**正确**的：它只持 3,001 USDC 而基准 10,000）。回归测试 4 条。
- **状态**: 已修复 → KI-24（resolved）

## 评审覆盖与验证的属性

| 区域 | 评审者 | 亲自验证 |
|---|---|---|
| 写路径唯一性 / guard | ReviewSafety | 用探针**证明**伪造 guard 在修复前可达非白名单地址；修复后 0 发送 |
| 原子性 §42 | ReviewCorrectness | 探针证明 hash 记录与 attempt 语义；变异测试（见下） |
| 幂等 §97 / 状态机 §98 | ReviewCorrectness | 探针覆盖"成功建仓后主行状态"、"REVERTED 后重试"、"UNKNOWN 不重发" |
| 估值与 §65/§96 | ReviewFailClosed | 探针在**真实组合**下证明 NAV=0 → 虚假停机；修复后 complete=true |
| §99 区块固定 | 集成方（评审者被中断） | 活链复现：两端点 `sqrtPriceX96` 第 9 位不同 → 修复后固定高度读取成功（KI-19） |

## 评审者使用的变异测试（变异推理）

ReviewCorrectness 在 `/tmp` 沙箱内对关键断言做变异，确认哪些"改错一行会被捕获"：

| 变异 | 是否被捕获 |
|---|---|
| `swapForDeficit` 静默降级为两笔（Pancake） | 捕获 |
| 移除 `assertTxGuard` | 捕获 |
| 禁用 tick 对齐断言 | 捕获 |
| `previousBlockhash` 静默换成 timestamp | 捕获 |
| impact 方向反转 | 捕获 |
| `amountOutMinimum <= 0` 检查禁用 | 捕获 |
| `mint` 到零地址检查禁用 | 捕获 |
| `burn > liquidity` 检查禁用 | 捕获 |
| guard 移到某次读取之后 | 捕获 |

（UniswapAdapter 提交时亦自报 9 项变异各自导致 ≥1 测试失败。）

## 局限（须在 Settlement 中如实记录）

1. **模型独立性不足**：三个评审者与开发者使用**同一模型配置**（`opencode-go/deepseek-flash`）。独立性由**独立会话**（无开发者上下文）+ 只读 + 要求"代码与命令输出才是证据"实现，**并非** `references/delivery-workflow.md` 建议的"不同模型配置"。这是本项目的**已知流程缺口**，须登记并建议后续配置独立评审模型。
2. **三个评审者均在产出正式 YAML 报告前因模型 400 中断**。本报告由**集成方**从其**探针脚本 + 会话记录 + 请求日志**取证整理，而非评审者自陈。取证对象是**可复现的探针与命令输出**，不含论断。
3. **未覆盖**：实盘仓位类路径（真实 collect/remove/首次 build）因无签名钱包与真实资金而未评审；`src/notify/telegram.ts` 的**真实** Bot API 交互（测试全为 mock）。

## questions（需用户决策）

1. **KI-15**：§5 的 NAV 公式与 §64 Profit Vault 不自洽，实现取"不重复计入 realized fees"的保守读法。**请确认此读法**（这是评审认为应当升级为用户决策的一项，因为它直接决定 §66 何时触发）。
2. **KI-13**：Mode 1 直接实盘但无 §103 金额阶梯；是否要加程序化金额上限？
3. 是否配置**不同模型**做独立评审以满足 L3 的独立性契约？

## 结论与下一步

```text
F1–F4 全部修复，回归测试 24 文件 / 701 测试全绿，`npm run typecheck` 0 错误。
评审者的原始探针在修复后复验通过（F1: 0 发送；F2: 主行 SUBMITTED 且可 resolve；F3: attempt 2 建立；F4: complete=true）。
→ 进入独立 Test 阶段。
```
