# Code Map

> 本文件随实现同步维护（Settlement 硬性验收项）。

## 状态

```text
代码：54 源文件 / 31 测试文件；
`npm run typecheck` 0 错误，`npm test` 803 测试全绿（2026-09-30）。

注意：测试为组件级，不代表产品可用。
      功能的真实接线状态以 `docs/product/feature-list.md` 为准 ——
      本仓库曾出现"测试全绿但建仓功能未接线"的情况。
```

## 功能接线状态

**组件存在 ≠ 功能可用。** 2026-09-30 之前本仓库有五处「写了但没接」，全部已修复：

| 组件 | 文件 | 生产调用点 | 状态 |
|---|---|---|---|
| `PositionExecutor.buildPosition` | `src/execution/positionExecutor.ts` | `src/runtime.ts:466`（经 `BuildOrchestrator`） | ✅ |
| `PoolScreener.screen` | `src/data/poolScreener.ts` | `src/strategy/buildOrchestrator.ts:142` | ✅ |
| `QueryHandlers` | `src/notify/telegram.ts`（接口） | `src/runtime.ts:246` | ✅ |
| `approveRebuild` | `src/execution/actionHandlers.ts`（接口） | `src/runtime.ts:305`（`decideRebuild`） | ✅ |
| `/start` · `/exit` 的建仓动作 | `src/execution/actionHandlers.ts` | 调用 `deps.buildPosition` | ✅ |

**新增的接线层**：

| 文件 | 作用 |
|---|---|
| `src/strategy/buildOrchestrator.ts` | §45 建仓编排：精筛 → 计划 → 报价 → §40/§41/§3 门禁 → 交给执行器 |
| ~~`src/strategy/rebuildPolicy.ts`~~ | **已删除**（D3.8：无自动重建，§6.4 成本上限随之作废） |
| `src/runtime/queryCache.ts` | 查询命令的数据来源：最近一次观测，不做现场读取 |
| `src/runtime/queryHandlers.ts` | `/status` `/position` `/pools` `/nav` `/risk` |

**实盘修正（2026-10-01 首次真金建仓暴露，均无法被 dry-run 发现）**：

| 位置 | 修正 | 基线 |
|---|---|---|
| `src/dex/pancakeV3.ts` | `#ensureAllowance` —— 此前**完全没有 approve 逻辑**，首次实盘必然 `STF` | §93 |
| `src/dex/pancakeV3.ts` | `#confirm` —— swap/建池前等待上一笔落块；不等确认时链上 allowance 仍为 0 | §98 |
| `src/chain/adapter.ts` | 签名账户传 `account` 对象而非地址字符串（后者走 `eth_sendTransaction`，公共 RPC 一律拒绝） | §95 |
| `src/config/builtins.ts` | 代币合约加入**写目标白名单**，否则 `approve` 被 §95 guard 拒绝 | §95 |

**T5/T6/T8 已落地（2026-10-02，双 DEX 实盘验收 + T8 实盘负例）**：`runAtomicBuild`/`swapForDeficit` 已删除；建仓 = swap→确认→读余额→mint→确认；**撤池 = remove(含烧 NFT)→确认→逐腿换 U→确认→纯 U 校验**（`exitLegs` 在烧毁前缓存腿元数据；尘埃阈值 0.0001 单位）；`UniswapV3Adapter.ensureAllowance`/`getTokenBalance`/burn 支路为日新增；`FundingPlanner` 增加建仓前纯 U 校验（residualHoldings 注入：批量白名单余额 + NPM NFT 计数，拒绝即 `WALLET_NOT_PURE_U`）。证据：`docs/research/evidence-live-{build,exit}-20261002*.txt`。

## 已实现（实际文件 → 导出 → 基线章节）

### 项目骨架（T1）

| 文件 | 内容 |
|---|---|
| `package.json` | ESM（`type: module`）、`engines.node >= 22.5`、脚本 `typecheck` / `test` / `test:watch` / `dev` / `keystore:init`。依赖锁定 `viem@2.37.13`（对齐 `@pancakeswap/v3-sdk@3.10.3` 的精确依赖）、`@pancakeswap/{v3-sdk@3.10.3,smart-router@7.8.0,sdk@5.9.3,chains@0.10.0}`、`yaml`、`zod` |
| `tsconfig.json` | `strict` 全开（含 `noUncheckedIndexedAccess`、`noUnusedLocals`、`useUnknownInCatchVariables`）。**模块解析：`module`/`moduleResolution` 均为 `nodenext`**（理由见下）。`noEmit`，由 Node 原生执行 TS + `rewriteRelativeImportExtensions` |
| `vitest.config.ts` | `tests/**/*.test.ts`，`testTimeout: 30s`（生产 scrypt 参数需要 1–2s/次） |
| ESLint | **未配置**（有意跳过）：TS 侧已有 `strict` + `noUnusedLocals`/`noUnusedParameters` + `noUncheckedIndexedAccess`，且 `npm run typecheck` 为强制门禁；在 T1 阶段引入 lint 插件链的收益不足以抵消配置成本。若后续需要风格约束，再单独补齐（不阻塞 T2–T12） |
| `.env.example` | `BSC_RPC_URL(_SECONDARY)`、`GECKOTERMINAL_API`、`DEXPAPRIKA_API`、`DEFILLAMA_API`、`THEGRAPH_API_KEY`、`BINANCE_FAPI_BASE_URL`、`TELEGRAM_{BOT_TOKEN,CHAT_ID,ALLOWED_USER_IDS}`、`STRATEGY_WALLET_ADDRESS`、`KEYSTORE_PATH`、`KEYSTORE_CHAIN_ID`、`DRY_RUN`（全部为占位；无任何真实密钥） |

**为什么选 `nodenext` 而不是 `bundler`**：本项目是 Node 直接执行（无打包器；`node src/main.ts` 原生跑 TS，`vitest` 亦按 Node ESM 解析），且代码会 `import` 纯 ESM 的 viem 与 Pancake SDK。`bundler` 允许省略扩展名与解析 `exports` 映射更宽松，但类型检查的解析结果会与运行时不符，容易漏掉真实运行期错误；`nodenext` 让 `tsc` 的解析与 Node 一致，代价是相对导入必须写 `.ts` 后缀（已全量遵守）。

**为什么不用 `better-sqlite3`**：运行环境为 Node v24.8.0，内置 `node:sqlite`（`DatabaseSync`）可用，免去原生编译与 N-API 版本升级风险；`node:sqlite` 目前带 ExperimentalWarning，这是 T11 选型时需复核的点（已登记）。

### 配置与白名单（T2）

| 文件 | 关键导出 |
|---|---|
| `src/config/builtins.ts` | `BUILTIN_TOKENS`（bStocks 8 个 + USDC/USDT + WBNB，均 18 decimals）、`BSC_ADDRESSES`、`BSC_BSTOCKS`、`BSC_STABLECOINS`、`BSC_WRAPPED_NATIVE`、`BSC_DEX_CONTRACTS`（Pancake/Uniswap V3 factory/NPM/router/quoter/tickLens/permit2）、`KNOWN_BSC_POOLS`、`SUPPORTED_CHAINS`、`WHITELIST_DEXES` |
| `src/config/schema.ts` | zod schema：`strategyFileSchema`、`tokensFileSchema`、`stablecoinsFileSchema`、`addressSchema`；类型 `StrategyYaml`、`StrategyConfigYaml`、`TokensYaml`、`StablecoinsYaml`、`TokenEntryYaml`、`WhitelistYaml` |
| `src/config/registry.ts` | `InMemoryTokenRegistry`、`mergeTokensWithOverrides`、`createBuiltinRegistry`、`tokenIdFor`、类型 `TokenOverride` |
| `src/config/index.ts` | `loadConfig`、`createWhitelist`、`defaultDexWhitelist`、`parseStrategyYaml`、`parseTokenOverrides`、`ConfigError`、`CONFIG_DIR_NAME` 等常量；re-export `schema` / `builtins` / `registry` |
| `config/strategy.yaml` | §85 全量（capital/monitor/range/yield/pool/swap/switch/risk/fees）+ `approvals` + `telegram` + `whitelist.chains/dexes` |
| `config/tokens.yaml` | §86：8 个 bStocks + WBNB，`contract` 为真实地址 |
| `config/stablecoins.yaml` | §87：USDC(priority 1) / USDT(priority 2)，真实地址 |

白名单语义（**冻结**）：

- **主键为 `chainId + lowercased contract address`**（`tokenIdFor`）。`getTokenByAddress(chainId, addr)` 只接受地址。
- **不提供任何 symbol → 地址 的公开 API**（有意为之：同链存在 `QQQB`/`QQQx`/`QQQon` 及疑似冒充地址与 8-decimals 同 symbol 合约，链上 ticker 大小写还不统一）。`symbol` 仅为展示别名。
- `assertWhitelistNonEmpty()` / `Whitelist.assertWhitelistNonEmpty()`：白名单为空即抛错（Fail Closed）。
- 内置条目**不可被配置删除**，`decimals` / `uiAmount` 策略 / `isStockToken` 亦不可被配置改写（不一致即启动失败）；其余属性可按地址覆盖。新增未知合约必须显式写 `decimals` 且默认 `auto_trade: false` + `HIGH_VOL`。
- 交叉校验（`loadConfig`）：depeg 阶梯必须严格递增、`warning_net_apr < target_net_apr`、`lower_ratio < 1 < upper_ratio`、`swap.max_price_impact <= pool.max_swap_price_impact`、`max_lp_ratio + reserve_ratio <= 1`、DEX 条目所属链必须在链白名单内。未知 YAML 键直接报错。

### Keystore（T3）

| 文件 | 关键导出 |
|---|---|
| `src/security/keystore.ts` | `encryptPrivateKey`、`decryptPrivateKey`、`readKeystoreFile`、`writeKeystoreFile`、`serializeEnvelope`、`parseEnvelope`、`buildAad`、`parseAad`、`zeroize`、`KeystoreError`、类型 `KeystoreEnvelope` / `ScryptParams` / `DecryptedPrivateKey` / `KeystoreErrorCode`、常量 `KEYSTORE_VERSION` / `KEYSTORE_KDF` / `SCRYPT_{N,R,P,KEY_LENGTH,MAXMEM}` / `DEFAULT_KEYSTORE_CHAIN_ID` |
| `scripts/keystore-init.ts` | CLI：交互式读取（TTY 关闭回显；管道输入走队列），写 `secrets/wallet.enc`（0600，目录 0700），写后回读并重新解密自检；已存在时拒绝覆盖（`--force` 才允许） |

- 信封：`{v, kdf, kdfParams, salt, iv, ciphertext, tag, aad}`；`kdf: 'scrypt'`；AES-256-GCM，12-byte IV，16-byte tag。
- **`maxmem` 显式传入且写入信封**：`N=2^17, r=8, p=1` 需 `128*N*r = 128 MiB`，Node 默认 32 MiB 会直接报错（research §5 的陷阱）。`assertParams` 拒绝 `maxmem < 128*N*r` 的任何参数。
- **AAD = `lptrader-keystore:v1:chainId=<id>:address=<lowercased address>`**，把格式版本 + chainId + 地址都绑进 GCM tag；篡改地址/chainId/密文/tag 一律认证失败。
- 解密失败**硬失败**：单一 `DECRYPT_FAILED`，无明文回退、无重试、无 legacy 分支；报错文本不含私钥/passphrase 片段（已单测 + 脚本证明）。
- 每次加密使用全新随机 salt(16B) 与 IV(12B)。

### 共享类型与接口（**已冻结**）

| 文件 | 导出 |
|---|---|
| `src/types/primitives.ts` | 类型 `Address` `Hex` `Hash` `ChainId` `DexId` `PoolId` `TokenId` `UnixSeconds` `IsoTimestamp` `Bps` `Ratio` `UsdAmount` `PriceUsd` `Tick` `SqrtPriceX96` `DurationSeconds` `FeeTier` `TokenRiskTier` `TokenKind`；值 `DEX_IDS` `TOKEN_RISK_TIERS` `TOKEN_KINDS` |
| `src/types/token.ts` | `TokenMeta`、`TokenAmount`（raw + ui + uiMultiplier）、`UiAmountPolicy`、`UI_AMOUNT_MODES` |
| `src/types/market.ts` | `PoolRef`、`PoolKey`、`PoolSnapshot`（含 `tokenNAVDeviation`、`swapImpact3500USD`）、`PoolFilterThresholds`、`PoolFilterResult`、`TickRange`、`PriceRange`、`Sourced<T>`、`DataSource`/`DATA_SOURCES` |
| `src/types/portfolio.ts` | `PortfolioSnapshot`（§5）、`Position`（§75；`status` 类型为 `BotState`）、`SwapRecord`（§76）、`DecisionLog`（§77；`state` 类型为 `BotState`）、`DrawdownState` |
| `src/types/adapters.ts` | `ChainAdapter`（§81）、`DexAdapter`（§82，含 `supportsAtomicBuild` 静态能力标志：执行器据此选择单笔原子建仓或两笔路径，禁止按 `dex` id 分支）、`PoolDataProvider`（§83）、`ReferencePriceProvider`（§84）、`TxGuardChecks`（§95）、`TxState`/`TX_STATES`（§98）、`SwapPurpose`/`SWAP_PURPOSES`（§76）、`ApprovalType`/`APPROVAL_TYPES`、`DeadlineSpec`、`PegLevel`/`PEG_LEVELS`（§55）、`MarketStatus`/`MARKET_STATUSES`（§56）、`SwapQuote`、`AddLiquidityRequest`（含 `swapForDeficit: AtomicSwapForDeficit`，§42 原子建仓）、`AtomicSwapForDeficit`、`RemoveLiquidityRequest`、`CollectFeesRequest`、`LpPositionView`、`PartialExecutionInfo` 等 |
| `src/types/state.ts` | `BOT_STATES`/`BotState`（§44 全量 + `PARTIAL_POSITION`/`EMERGENCY` 两个登记扩展）、`BOT_STATE_TRANSITIONS`（§88 邻接表）、`NO_NEW_CAPITAL_STATES`、`READ_ONLY_STATES` |
| `src/types/notifier.ts` | `Notifier`、`noopNotifier`、`AlertSeverity`/`ALERT_SEVERITIES`（§78）、`ApprovalKind`/`APPROVAL_KINDS`、`ApprovalStatus`/`APPROVAL_STATUSES`、`ApprovalRequest`、`ApprovalDecision`、`NotifyOptions` |
| `src/types/registry.ts` | `TokenRegistry`、`Whitelist`、`WhitelistDexEntry`、`WhitelistError` |
| `src/types/config.ts` | `StrategyConfig`、`CapitalConfig`、`MonitorConfig`、`RangeConfig`、`YieldConfig`、`PoolThresholdConfig`、`SwapConfig`、`SwitchConfig`、`RiskConfig`、`FeesConfig`、`ApprovalsConfig`（`buildPosition:'confirm'`/`switchPool:'confirm'`/`others:'auto'`/`timeoutMinutes`）、`TelegramConfig` |
| `src/types/index.ts` | 上述全部 re-export（含三条接口约定文档） |

### 入口

| 文件 | 内容 |
|---|---|
| `src/main.ts` | Phase A 只读入口：`loadConfig` → `assertWhitelistNonEmpty` → 逐条 `assertWhitelistedDex` → 可选 keystore 结构校验 → 打印摘要（链、DEX、可交易股票、稳定币优先级、§66 risk-off NAV、审批策略、dry-run）。**不连链、不发交易** |

## 测试入口

| 命令 | 覆盖 |
|---|---|
| `npm run typecheck` | 全仓 `tsc --noEmit`；`tests/types/contract.test.ts` 的类型级断言（`@ts-expect-error` 反向验证联合类型未被放宽） |
| `npm test` | 3 个文件 60 个用例：`tests/config/registry.test.ts`（25）、`tests/security/keystore.test.ts`（19）、`tests/types/contract.test.ts`（16） |
| `npm run dev` | Phase A 配置/白名单自检（只读） |
| `npm run keystore:init` | 生成 `secrets/wallet.enc`（0600），写后回读自检 |
| 链上只读冒烟 / dry-run 建仓脚本 | 待 T4/T5/T9 交付后登记（`scripts/smoke-read.ts`、`scripts/smoke-scan.ts`、`scripts/dry-run-build.ts`） |

## 已实现（Iteration 1 全部模块：文件 → 用途 → 基线章节）

> 每个文件都可 `git ls-files` 确认已入库（曾发生 `.gitignore` 未锚定导致整层未跟踪的事故，故此处显式登记）。

### 链访问层 `src/chain/`（§81/§95/§98/§99）

| 文件 | 内容 |
|---|---|
| `adapter.ts` | `BscChainAdapter implements ChainAdapter`；多 RPC + §99 cross-check；§95 `assertTxGuard`；§98 交易状态机；`dryRun`；**唯一写路径 `sendTransaction`** |
| `rpc.ts` | `RpcPool`、`handlerTransport`、`resolveEndpoints`、`CrossCheckError`、`RpcUnavailableError`；**`crossCheck` 固定区块高度**（KI-19 修复） |
| `tokenReader.ts` | BEP-677 探测（ERC-165）与 `balanceOfUI`/`toUIAmount`/`fromUIAmount`；`uiMultiplier()` **运行期读取** |
| `poolReader.ts` | `slot0`/`liquidity`/`fee`/`token0`/`token1`/`tickSpacing`、`sqrtPriceX96ToPrice` |
| `positionReader.ts` | NPM `positions`/`ownerOf`/枚举/`tokensOwed`（未领取 fee）；`liquidityToAmounts` 供 NAV 用 |
| `txState.ts` | §98 生命周期与 `TxStateUnknownError`（UNKNOWN 不重发） |
| `abis.ts` / `errors.ts` / `index.ts` | ABI 常量、错误码、barrel |

### DEX 适配层 `src/dex/`（§82/§39–§43）

| 文件 | 内容 |
|---|---|
| `index.ts` | **共享且冻结**：`DEX_FEE_TIERS`、`tickSpacingFor(dex, fee)`、`feeTiersFor`、`DEX_PREFERENCE`、`createDexAdapter`、`isNoPool`；`DexAdapterFactoryOptions` 含必需 `chain` |
| `pancakeV3.ts` | `PancakeV3Adapter`；QuoterV2 报价；§42 原子路径已删除（D3.7）；`#ensureAllowance`/`#confirm`/receipt 解析 tokenId |
| `uniswapV3.ts` | `UniswapV3Adapter`；`ensureAllowance`（2026-10-02 新增 —— 此前**完全没有 approve 逻辑**，实盘首笔 swap 即 `STF`）；NPM 无 blockhash deadline 重载 → 明确拒绝 |

### 数据层 `src/data/`（§14–§26/§54–§57/§83/§84）

| 文件 | 内容 |
|---|---|
| `poolDataProvider.ts` | 三层 `LayeredPoolDataProvider`（GeckoTerminal / DexPaprika / RPC）；限流 + 429 退避 + 缓存；`stale`/`source` 标注；fees 标为 `derived` |
| `poolScanner.ts` | `PoolScanner`、`enumerateCandidatePairs`（§14 交叉集）、`POOL_EXISTENCE`/`POOL_EXISTENCE_EVIDENCE`（**区分「已证明不存在」与「无法验证」**）、`onchainVerifiedByPool`、`foundPools`/`describeAbsences` |
| `poolFilter.ts` | §16 硬性过滤 `evaluatePoolFilters`/`filterPools`；`isOnchainVerified` → 未验证即拒（§96）；`decisive` 区分「数据缺失」与「池不合格」 |
| `bscOnchainSource.ts` | `BscOnchainPoolStateSource`：`slot0`/`liquidity`/`fee`/`factory.getPool` 的窄接口读取 |
| `referencePrice.ts` | `BinanceReferencePriceProvider`：index price → spot → 链上 oracle 阶梯；占位值 `price<=0` 判定；§56 市场状态；§57 `usableForHardExit` |

### 策略层 `src/strategy/`（§5–§7/§18–§20/§33–§41/§44–§67）

| 文件 | 内容 |
|---|---|
| `positionPlanner.ts` | `planPosition`（§33–§38）：比率→tick 对齐→**以 USD 总量反解 L**→三分支金额→§38 swap；`liquidityToAmounts`、`tickSpacingForFee` |
| `swapPlanner.ts` | `evaluateSwapQuote`（§40/§41 闸门）、`planSwapIntent`、`computePriceImpact`（**本地自算**）、`classifyRange`、`computeFeeAprFromTotals` |
| `nav.ts` | `buildPortfolioSnapshot`（§5 NAV）、`buildDrawdownState`（§65–§67，含 `<=` 边界）、`computeBenchmarkMetrics`（§6/§7 IL 与 FeeILRatio） |
| `riskManager.ts` | §53–§67：脱锚五档（§55）+ 闭市降级（§57）、回撤线（§66）、TVL 崩溃（§59）、reserve（§60）、区间（§49–§51）、9 类 emergency（§58）；`evaluateRisk` 复合报告 |
| `stateMachine.ts` | §44/§88 `transition`、持久化 `StateMachine`、`WRITE_ACTIONS` 写门（`READ_ONLY_STATES`/`NO_NEW_CAPITAL_STATES`） |

### 执行层 `src/execution/`（§39–§43/§46/§89/§95–§98）

| 文件 | 内容 |
|---|---|
| `positionExecutor.ts` | 建仓/退出/收手续费的编排；四道闸门（§95 guard → §44 写门 → §40/§41 报价门 → 确认门）；**建仓统一两笔**（§5.4/D3.7，2026-10-02 已落地：swap→确认→读余额→mint→确认）；§43 partial；§97 幂等 |
| `portfolioMonitor.ts` | §46 组合监控：读钱包、定价、LP 估值、§65 回撤；`complete=false` 表示估值不完整（§96） |
| `scheduler.ts` | §89 调度：按 cadence 触发、**不重叠**、失败上报且不杀循环 |
| `approvalGate.ts` | `ApprovalGate`（`gate`/`request`/`awaitDecision`）、SQLite/内存 store、§77 审计 sink；`BUILD_POSITION`/`SWITCH_POOL` 唯一放行路径 |
| `approvalMigration.ts` | 向 `StateStore` 注册 version 100 迁移（`approval_requests`） |

### 存储层 `src/store/`（§74–§77/§97/§98）

| 文件 | 内容 |
|---|---|
| `db.ts` | `node:sqlite` 连接 + WAL + 开放迁移注册表（`registerMigration`/`applyMigrations`）；**内存库不共享**（KI-16 修复） |
| `stateStore.ts` | `positions`/`swap_records`/`decision_logs`（§75–§77）+ `RuntimeStateStore`（当前 bot 状态） |
| `txStore.ts` | §98 `tx_records`、§97 幂等键、`findUnresolved`、`applyChainObservation`、`planUnresolvedRecovery` |

### 通知层 `src/notify/`

| 文件 | 内容 |
|---|---|
| `telegram.ts` | `TelegramNotifier implements Notifier`、`createNotifierFromConfig`（无 token/禁用 → `noopNotifier`，**永不放行**）、长轮询、内联 Approve/Reject、`QueryHandlers`、用户白名单鉴权 |

### 装配与工具

| 文件 | 内容 |
|---|---|
| `src/runtime.ts` | 组合根：白名单校验 → store/state → signer（可选，无则只读）→ 构造**全部白名单 DEX 适配器（共用同一 chain 实例）**→ monitor/scanner/executor；`buildCadences` |
| `src/main.ts` | Phase A 只读入口：`loadStartupSummary` 配置/白名单自检，不连链不发交易 |
| `src/util/decimal.ts` | `toFloat`/`fromFloat`/`applyFloorRatio`（bigint↔float，无精度溢出；floor 方向为签名安全方向） |
| `src/security/keystore.ts` | AES-256-GCM + scrypt（显式 `maxmem`）、版本化信封、AAD 绑定 chainId+地址 |

## 脚本（可运行证据入口）

| 命令 | 作用 | 是否需要 key |
|---|---|---|
| `npm run dev` | Phase A 配置/白名单自检（只读） | 否 |
| `npm run keystore:init` | 生成 `secrets/wallet.enc`（0600） | 否（交互输入口令） |
| `npm run smoke:read` | 链上只读冒烟：池状态/余额/`uiMultiplier` | 否 |
| `npm run smoke:scan` | 真实三层扫描 + §16 过滤 | 否（约 4 分钟，6s 节流） |
| `npm run smoke:quote` | 真实 QuoterV2 报价 + §40 闸门 | 否 |
| `npm run dry-run:build [capital]` | **完整决策链，不签名不发送** | 否 |
| `npm run telegram:check` | Telegram 通道自检（fail-closed 验证） | 是 |

## 测试入口

| 命令 | 覆盖 |
|---|---|
| `npm run typecheck` | 全仓 `tsc --noEmit`（当前 **0 错误**）+ 类型级契约断言 |
| `npm test` | **24 文件 / 690 测试**全绿 |
| `npm run test:approval` | 确认门 + Telegram 专项（55） |

## 证据文件（`docs/research/`）

| 文件 | 内容 |
|---|---|
| `evidence-smoke-read-20260929.txt` | 只读冒烟真实输出（含 8 个 bStock 的 `uiMultiplier()` 实测值与 `toUIAmount` 一致） |
| `evidence-smoke-scan-20260929-t6.txt` | 真实扫描输出（2 池通过 §16，27+ 条 proven-absent，0 unverifiable） |
| `evidence-pool-scanner-filter-20260929.md` | 同上的分析记录 + §16 结果解读 |
| `evidence-dry-run-build-20260929.txt` | **完整建仓决策链**（计划/报价/闸门/资金校验），不发送 |

金额单位、身份规则与 Fail Closed 三条约定见 `src/types/index.ts` 顶部注释；下游实现必须遵守。
