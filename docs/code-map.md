# Code Map

> 项目处于 Planning 阶段：尚无代码。本文件随实现同步维护（Settlement 硬性验收项）。

## 状态

```text
代码：尚未创建（Iteration 1 Planning 阶段）
```

## 计划中的入口与模块（来自 `docs/product/stock-lp-auto-strategy-v1.md` §80–§84）

实现后在此登记：文件路径 → 模块 → 对应基线章节。计划骨架：

```text
src/
  main.ts                     入口：启动口令 → 解密 keystore → 装配服务 → 调度
  config/                     StrategyConfig（YAML）+ Token/Stablecoin/DEX/Chain 白名单
  chain/                      ChainAdapter（viem）
    bsc.ts
  dex/                        DexAdapter
    pancakeswapV3.ts
    uniswapV3.ts              最小自实现（不共享 Pancake SDK 对象）
  data/
    poolScanner.ts            PoolScanner         §14
    poolFilter.ts             PoolFilter          §16
    poolRanker.ts             PoolRanker          §21–§26
    poolDataProvider.ts       PoolDataProvider    §83
    referencePrice.ts         ReferencePriceProvider §84
  strategy/
    positionPlanner.ts        PositionPlanner     §33–§38
    swapPlanner.ts            SwapPlanner         §39–§41
    swapExecutor.ts           SwapExecutor        §42–§43
    liquidityManager.ts       LiquidityManager    §39、§71
    yieldAnalyzer.ts          YieldAnalyzer       §18–§20
    riskManager.ts            RiskManager         §54–§68
    benchmark.ts              BenchmarkEngine     §6、§7
    stateMachine.ts           StateMachine        §44、§88
  execution/
    portfolio.ts              PortfolioManager    §5
    nav.ts                    NAVService          §5
    txGuard.ts                Transaction Protection §95–§98
  store/
    sqlite.ts                 StateStore          §74
  notify/
    telegram.ts               NotificationService §78
  security/
    keystore.ts               AES-256-GCM + scrypt（见 AGENTS.md 密钥管理）
tests/                        见 docs/iterations/iteration-1.md 验收映射
```

## 测试入口

（实现后登记：`npm test` 范围、链上只读冒烟脚本、dry-run 建仓脚本）
