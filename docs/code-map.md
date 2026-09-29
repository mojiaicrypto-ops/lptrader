# Code Map

> 本文件随实现同步维护（Settlement 硬性验收项）。

## 状态

```text
代码：已创建（Iteration 1 / D3 T1–T3 + 共享契约层；T4–T12 待实现）
```

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

### 共享类型与接口（T4–T12 契约，**已冻结**）

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

## 待实现（T4–T12，接口已冻结）

原计划骨架（模块 → 基线章节）仍然有效，逐项对应如下；已落地者见上表。

```text
src/
  main.ts                     入口：启动口令 → 解密 keystore → 装配服务 → 调度   ← 已落地（Phase A 只读子集）
  config/                     StrategyConfig（YAML）+ Token/Stablecoin/DEX/Chain 白名单 ← 已落地
  types/                      共享契约层（T4–T12 接口）                          ← 已落地
  security/keystore.ts        AES-256-GCM + scrypt（见 AGENTS.md 密钥管理）      ← 已落地
  chain/                      ChainAdapter（viem）                               T4
    bsc.ts                    多 RPC 故障切换 + multicall3 批读
    poolReader.ts             池 slot0/liquidity/fee                             T5
    tokenReader.ts            余额 + BEP-677 UI 换算（uiMultiplier 运行期读取）    T5
  dex/                        DexAdapter                                         T9
    pancakeswapV3.ts          官方 @pancakeswap/v3-sdk + SmartRouter 原子路径
    uniswapV3.ts              最小自实现（不共享 Pancake SDK 对象）
  data/
    poolDataProvider.ts       PoolDataProvider    §83                             T6
    poolScanner.ts            PoolScanner         §14                             T6
    poolFilter.ts             PoolFilter          §16                             T6
    poolRanker.ts             PoolRanker          §21–§26                         T6
    referencePrice.ts         ReferencePriceProvider §84                         T7
  strategy/
    positionPlanner.ts        PositionPlanner     §33–§38                         T8
    swapPlanner.ts            SwapPlanner         §39–§41                         T9
    riskManager.ts            RiskManager         §54–§68                         T10
    stateMachine.ts           StateMachine        §44、§88                        T11
    benchmark.ts              BenchmarkEngine     §6、§7                          T12
  execution/
    swapExecutor.ts           SwapExecutor        §42–§43                         T9
    liquidityManager.ts       LiquidityManager    §39、§71                        T9
    txGuard.ts                Transaction Protection §95–§98                     T9
    portfolio.ts              PortfolioManager    §5                              T12
    nav.ts                    NAVService          §5                              T12
  store/
    sqlite.ts                 StateStore          §74                             T11
  notify/
    telegram.ts               NotificationService §78（实现 Notifier 契约）        T12
```

金额单位、身份规则与 Fail Closed 三条约定见 `src/types/index.ts` 顶部注释；下游实现必须遵守。
