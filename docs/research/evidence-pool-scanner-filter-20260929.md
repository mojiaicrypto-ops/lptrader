# T6 acceptance evidence — Pool Scanner / Pool Filter

Companion to `docs/iterations/iteration-1-acceptance.md`. Every row below names the **test** that
closes it and the **assertion** that makes it evidence; the items the offline tests cannot prove are
closed by the live scan output pasted in §3.

Raw command output for §3 is archived verbatim at `docs/research/evidence-smoke-scan-20260929-t6.txt`.

---

## 1. Pool Scanner (5 items)

| # | 验收项 | 证据 | 断言要点 |
|---|---|---|---|
| S1 | 正确读取池 TVL | `tests/data/poolDataProvider.test.ts › keeps GeckoTerminal as canonical TVL and records the DexPaprika value beside it` / `falls back to DexPaprika TVL only when GeckoTerminal reports none, and says so`；`tests/data/poolScanner.test.ts › factory.getPool returning a real address is reported as found by the factory` | TVL 有**唯一 canonical**（GeckoTerminal `reserve_in_usd`），DexPaprika `liquidity_usd` 只进 `diagnostic.crossChecks`（`canonicalSource=geckoterminal` / `crossSource=dexpaprika`），**不平均、不混用**；GT 缺失时才回退并记录 warning。实测：`QQQB/USDC tvlUSD $1,783,477.88 [geckoterminal]` vs 调研 §4.1 的 ~$1.77M |
| S2 | 正确读取 24h Volume | `poolDataProvider.test.ts › keeps canonical volume24h from GeckoTerminal and the 7d volume from DexPaprika` | `volume24h.source === 'geckoterminal'` 且值等于 GT `volume_usd.h24`；实测 `$1,422,704.61`（调研 §4.1 为 $1.34M，同量级） |
| S3 | 正确读取 7D Volume | 同上 + `poolScanner.test.ts › trap 1: … resolves the factory-address form in dex_id` | `volume7d.source === 'dexpaprika'`（GT 无 7d 字段，研究 §4.4 的事实）；实测 `$2,810,543.88`，并逐池打印 |
| S4 | 正确读取 Fee Tier | `poolDataProvider.test.ts › uses the on-chain values and marks the pool verified when the RPC answered` / `never lets DexPaprika's null fee become the fee tier` | RPC `fee()` 是真值、GT `pool_fee_percentage` 是回退、**DexPaprika `fee=null` 永不参与**；实测 Pancake `100` / Uniswap `3000`，与调研 §4.1 完全一致 |
| S5 | 正确读取 Active Liquidity | `poolDataProvider.test.ts › without an RPC layer, tick/liquidity are placeholders and the pool is reported unverified` / `a failed on-chain read is a fatal failure, not a zeroed pool state`；live 输出 | `activeLiquidity` **只能**来自 RPC `liquidity()`；RPC 缺失/失败时 `diagnostic.onchainVerified === false` 且 §16 过滤器以 `ONCHAIN_UNVERIFIED` 淘汰（见 F6）。实测非零真值，例：`0xe531fcb1… activeLiquidity 1511306225692084162659627` |

## 2. Pool Filter (6 items + §16 五个条件)

| # | 验收项 | 证据 | 断言要点 |
|---|---|---|---|
| F1 | TVL 过滤 | `poolFilter.test.ts › §16 TVL >= min_tvl_usd`（2 例） | `>=` 方向：**恰好 500000 通过**，`499999.99` 淘汰，reason 含实际值与阈值 |
| F2 | Volume 过滤 | `poolFilter.test.ts › §16 7D avg daily volume …`（4 例，含反例） | **断言用的是均日量**：7d 总量恰好 250000 **淘汰**本人已断言（`actual === 250000/7`，reason 同时打印 `7D total`）；`24h 高量不能替代 7d 均日量` |
| F3 | Token 白名单 | `poolFilter.test.ts › a same-symbol impostor address is rejected as a leg`、`rejects a non-whitelisted STABLECOIN leg…` | 用真实同名异物 `0xb904108b…`（调研 §1）构造：**同 symbol 不同地址 → 淘汰**，reason 明写 "regardless of any symbol"；stock/stablecoin 两腿独立判定 |
| F4 | Stablecoin 白名单 | 同上（异物置于 stablecoin 槽位） | `STABLECOIN_LEG_MISSING` 命中而 `STOCK_LEG_MISSING` 不命中，证明两腿分别校验 |
| F5 | DEX 白名单 | `poolFilter.test.ts › rejects a pool on a DEX that is not whitelisted for the chain (§12)`、`rejects a pool on a chain that is not whitelisted` | 只白名单 Uniswap V3 的 whitelist 下，Pancake 池 `failedCodes === ['DEX_NOT_WHITELISTED']` |
| F6 | NAV Deviation 过滤 | `poolFilter.test.ts › §16 token/NAV deviation < max_nav_deviation`（3 例） | **严格小于**：恰好 `0.01` **淘汰**，`0.009999` 通过；`null`（无可信参考价，§57）→ `NAV_DEVIATION_UNAVAILABLE`，fail closed |
| — | （附加，§16 第五项）$3500 Swap Impact | `poolFilter.test.ts › §16 $3500 swap price impact < max_swap_price_impact`（3 例） | **严格小于**：恰好 `0.005` 淘汰；链上报价失败 → `SWAP_IMPACT_UNAVAILABLE`（不是 0%） |

### §16 阈值来源与 fail-closed（任务书要求的两项）

- **阈值来自 config，不硬编码**：`poolFilter.test.ts › resolves the §16 defaults from config/strategy.yaml`（断言 `loadConfig().pool` 的五个值 + `describeThresholds` 文案）+ `changing a config threshold flips the verdict without touching the snapshot`（同一 snapshot，阈值 500000→600000，判定由 PASS 变 `TVL_BELOW_MINIMUM`）。
- **FAIL CLOSED（最关键一项）**：`poolFilter.test.ts › fail closed: stale / unavailable figures are rejections, never near-misses`（5 个参数化用例 + 4 个专项）——`stale === true` 或 `source === 'unavailable'` 的字段**一律**给出 `*_UNAVAILABLE` 且 `actual === null`，`failedCodes` 中**不出现**对应的数值型 `*_BELOW_MINIMUM`；并专测「0 值的 unavailable TVL 不得被读成『没有流动性』」。`filterPools` 在存在此类淘汰时 `decisive === false`，供运行时升级为告警（`src/runtime.ts` 已如此接线）。

## 3. 真实运行证据（`scripts/smoke-scan.ts`）

命令：
```
node --experimental-strip-types --env-file-if-exists=.env scripts/smoke-scan.ts
```

关键行（完整输出见归档文件）：

```
  elapsed                  186.0s
  probes                   70
  pools discovered         11
  scheduler                geckoterminal=26 req / 10×429   dexpaprika=6 req / 0×429
  complete                 true
...
§16 summary
  passed                   2
  rejected                 9
  decisive                 false (false = a rejection came from missing data)
...
sanity check vs research §4.1
  OK    QQQB/USDC @ uniswap-v3: feeTier 3000 (research: 3000), tvl $1,783,477.88 (research: ~$1.77M)
  OK    QQQB/USDT @ pancakeswap-v3: feeTier 100 (research: 100), tvl $623,813.64 (research: ~$0.62M)
  SKIP  QQQB/WBNB @ pancakeswap-v3 fee 500 — outside the §14 cross set
SCAN COMPLETE: 0 blocker(s)
```

与调研 §4.1 的对照结论（**如实报告，未做粉饰**）：

- 两个已知 QQQB 池都发现，**feeTier 与 TVL 均吻合**（$1.78M / $0.62M vs 调研 $1.77M / $0.62M）。
- `QQQB/WBNB` **未成为候选**，原因是**按设计排除**而非缺陷：§14 的扫描对象是「whitelist stock token × whitelist **stablecoin** × whitelist DEX」，WBNB 是 `WRAPPED_NATIVE` 而非稳定币。脚本据此打印 `SKIP` 而不是 `MISS`。
- 存活过滤结果：`QQQB/USDT @ Pancake 0.01%` 与 `AAPLB/USDT @ Pancake 0.25%` **PASS**；`QQQB/USDC @ Uniswap 0.3%` 因 `$3500 swap impact 0.6649% >= 0.5%` 淘汰（§16 硬门槛），这是本次运行的真实观测值，不是构造。
- 3 个 `swapImpact3500USD unavailable` 的池，其 7d 量为 unavailable 且 TVL≈$0（GT 报 `$4.79` / `$0.07`），链上 `liquidity()` 为 0 —— 属真实「无流动性池」，与「数据源故障」被明确区分（见 S5）。
- 单次扫描 186s、GeckoTerminal 观察到 10 次真实 429 并全部退避成功 → §4.4 的限流事实在运行中得到验证。

## 4. 无法用当前实现覆盖的项

无。5 项 Scanner + 6 项 Filter 全部有可重跑的测试或运行输出。

两处**超出本切片、已上报**的观察（不影响上述验收）：

1. `docs/research/evidence-smoke-scan-20260929.txt` 称 round-1 的列注释「需验证」，而
   `src/data/bscOnchainSource.ts` 目前发的是 Uniswap V3 派生/不可变选择器（`slot0()` `0x3850c7bd`、
   `liquidity()` `0x1a686502`、`fee()` `0xddca3f43`、`tickSpacing()` `0xd0c93a7c`、`token0()`
   `0x0dfe1681`、`token1()` `0xd21220a7`）。本次 smoke 对 Pancake 池（`0xe531fcb1…`）返回了
   **非零 tick/liquidity/真实价格**，与「Uniswap 选择器」一致 → `[INFERENCE]` 该文档注释很可能写反了；
   但结论仍需 T4/T5 拥有者做独立 selector 核对，未据此改动任何代码。
2. `FetchHttpTransport` 原先无请求超时，会让 60 分钟 cadence 静默永久阻塞（已修，见 `DEFAULT_HTTP_TIMEOUT_MS`）。
