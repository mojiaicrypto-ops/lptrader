# D2 — Implementation Summary

```yaml
implementation:
  task: D2
  scope_delivered: >
    Iteration 1（Phase 3 单池实盘）全部模块：链接入层、DEX 适配层（Pancake 原子 + Uniswap 两笔）、
    数据层（三层数据源 + 扫描 + 硬性过滤 + 参考价）、策略层（CL 数学 / 报价闸门 / NAV / 风控 / 状态机）、
    执行层（编排 / 组合监控 / 调度 / 确认门）、存储层、Telegram 通知、组合根与 6 个可运行脚本。
  changed:
    - path: src/chain/**
      purpose: §81 ChainAdapter + §99 多 RPC cross-check + §95 guard + §98 交易状态机 + BEP-677 读法
    - path: src/dex/**
      purpose: §82 两个 `DexAdapter`；`supportsAtomicBuild` 区分 §42 原子（Pancake）与两笔（Uniswap）
    - path: src/data/**
      purpose: §14/§15/§16 扫描与硬性过滤；§83 三层数据源；§84 参考价（含 §57 闭市降级）
    - path: src/strategy/**
      purpose: §33–§38 建仓数学；§39–§41 报价闸门；§5–§7 NAV/benchmark；§53–§67 风控；§44/§88 状态机
    - path: src/execution/**
      purpose: §39–§43 编排（四道闸门）；§46 组合监控；§89 调度；D2 确认门
    - path: src/store/**
      purpose: §74–§77 持久化；§97 幂等；§98 交易记录与启动恢复
    - path: src/notify/telegram.ts
      purpose: §78 告警 + D2 双向确认（无 token → noopNotifier，永不放行）
    - path: src/runtime.ts
      purpose: 组合根；白名单校验 → store → signer（可缺，缺则只读）→ 共用同一 chain 实例构造全部 DEX 适配器
    - path: scripts/**
      purpose: 可运行证据入口（只读冒烟、扫描、报价、dry-run 建仓、keystore、telegram 自检）
  behavior:
    - 真实链上只读冒烟通过：8 个 bStock 的 `uiMultiplier()` 全部实测读出，本地换算与合约 `toUIAmount` 逐样本 MATCH
    - 真实扫描通过：`complete=true`，2 个池通过 §16，27+ 条 proven-absent，0 条 unverifiable
    - 真实报价通过：1000 USDT → 1.355335 QQQB，impact 0.0123%，TTL 精确 30s，§40 闸门通过
    - dry-run 建仓通过完整决策链：价值总和 4900.00 精确、ticks 对齐、§35 反证 4.400%、独立 impact 复算 **exact**、原子性单笔
  tests_changed:
    - 25 个测试文件、690 个测试；`npm run typecheck` 0 错误
  plan_deviations:
    - 新增 `src/dex/index.ts`（未在 Plan 的 T 列表内）：DEX 工厂 + **按 DEX 分离的 fee→tickSpacing 表**。理由：Pancake 与 Uniswap 的 fee 枚举不同，共用一张表会静默选错池；工厂同时强制 `assertWhitelisted()`。
    - 新增 `src/execution/portfolioMonitor.ts`、`src/execution/scheduler.ts`、`src/runtime.ts`（T12 的装配与 §46 监控/§89 调度在 Plan 中只以「调度」一句带过）。
    - 契约层在实现期被追加 3 项（均由集成方提出、契约所有者裁定，且均为收窄）：`Position.status`/`DecisionLog.state` → `BotState`；`AddLiquidityRequest.swapForDeficit`（§42 原子建仓的可表达性）；`DexAdapter.supportsAtomicBuild`；并**删除** `SwapExecutionRequest.atomic`（避免两处表达原子性）。
  document_impact:
    - docs/code-map.md（全量登记已实现模块与证据路径）
    - docs/iterations/iteration-1-acceptance.md（§108 逐项证据与状态）
    - docs/known-issues.md（KI-11～KI-20：范围裁剪、NAV 读法、DB 隔离、确认门超时、快照区块一致性等）
    - docs/research/evidence-*.{txt,md}（4 份真实运行证据）
    - PROJECT.md、docs/iterations/iteration-1.md（状态与实测可执行性）
  risks_remaining:
    - KI-15：§5 NAV 公式与 §64 Profit Vault 不自洽的读法**待用户确认**
    - KI-17：Notifier 返回不匹配 requestId 时确认门挂到 TTL 才拒绝（fail closed，但会挂住执行器）
    - KI-18/KI-20：PoolSnapshot 的 tick/liquidity 无可用性位；同快照多字段未共享区块高度
    - 实盘仓位类证据（真实 collect/remove/首次 build）需签名钱包与真实资金，属 D2 确认门的正常结果
    - 真实 §16 下只有 PancakeSwap 池可执行；Uniswap QQQB/USDC 池因 $3500 impact 0.66% > 0.5% 被淘汰
