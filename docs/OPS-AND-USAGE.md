# lptrader 综合文档（部署运维 + 日常使用）

**一份读到底的版本**，内容为 `OPS.md`（新机器部署与运维）与 `USAGE.md`（日常使用）的合并。
想分读：部署看 `OPS.md`，日常看 `USAGE.md`。

**本文中的命令行都在仓库根目录执行。**

---

# 第一部分 · 部署与运维

## 1. 这个系统是什么，运维者需要知道的三件事

它是一个在 BNB Chain 上管理「股票代币 / 稳定币」集中流动性 LP 的自动程序。运维角度只需记住三条：

1. **它默认什么都不会做。** 没有 Telegram 通道时，**建仓与换池永远无法执行**（这是设计，不是故障）。见 §6。
2. **它只会拒绝，不会自作主张。** 找不到价格、读不到链上状态、报价过期、超出配置比例 —— 一律拒绝并就绪等待，不会"猜一个值继续"。
3. **它自己不做复投、不做补仓、不做金额阶梯。** 资金由人手动增加；程序只保证**严格按配置比例执行并持续监控**。

> **本文中的命令行都在仓库根目录执行。** 请先 `cd` 到仓库根，再复制命令。

---

## 2. 新机器部署

### 2.1 前置条件

| 项 | 要求 | 为什么 |
|---|---|---|
| 操作系统 | macOS / Linux（POSIX shell） | 启动脚本走 shell |
| **Node.js** | **≥ 22.6.0**（实测 24.x；`package.json` 里有 `engines` 强制声明） | 直接用 Node 跑 TypeScript，**不需要编译步骤**；低于此版本无法执行 `.ts` |
| 磁盘 | ≥ 500 MB（`node_modules` 约占 300 MB） | 依赖包含 Pancake SDK 全家桶 |
| 网络出站 | 允许访问：BSC RPC、`api.binance.com`、`fapi.binance.com`、`api.geckoterminal.com`、`api.dexpaprika.com`、`api.telegram.org` | 报价、参考价、池数据、审批通道 |
| 时间同步 | 必须准确（NTP） | 报价 TTL、审批过期、市场开闭判断都依赖时钟 |
| git | 任意版本 | 拉代码 |

**不需要**：Docker、数据库服务（用内嵌 SQLite）、编译器工具链（**没有原生依赖，无 `node-gyp` 编译**）。

### 2.2 部署步骤

```bash
# 1) 取代码
git clone <你的仓库地址> lptrader
cd lptrader

# 2) 确认 Node 版本
node --version          # 必须 >= 22.6.0

# 3) 安装依赖（严格按 package-lock.json 复现）
npm ci                  # 没有 lock 文件时用 npm install

# 4) 确认仓库完整：0 错误 + 全部测试通过
npm run typecheck       # 期望：无输出（0 错误）
npm test                # 期望：25 个测试文件 / 725 个测试全部通过
```

`npm test` 是**部署验收的关键一步**：它在离线环境验证密码学、数学、风控阈值、确认门等核心行为。**不通过就不要继续**。

### 2.3 目录与文件权限

```bash
chmod 700 secrets        # 若 secrets/ 已存在（存放加密私钥）
chmod 600 secrets/*.enc
```

`.gitignore` 已排除 `secrets/`、`*.enc`、`.env*`、`data/`。**请在部署后用下面这条自查**：

```bash
git check-ignore -v secrets/wallet.enc .env data/lptrader.db
```

三条都应输出（表示被忽略）。**任何一条没输出，都是危险信号** —— 意味着密钥或运行期数据可能被提交。这一点值得坚持检查：本项目交付过程中曾因 `.gitignore` 规则未锚定（裸 `data/` 会匹配 `src/data/**`）导致整层代码从未入库，`git status` 完全看不出来。

> 自查文件是否真的入库，**只能用** `git ls-files`：
> ```bash
> for d in src tests scripts config; do
>   printf '%-8s %s tracked / %s on disk\n' "$d" "$(git ls-files $d | wc -l | tr -d ' ')" "$(find $d -type f | wc -l | tr -d ' ')"
> done
> ```
> 两边数字应一致。

---

## 3. 配置

全部配置集中在**三个 YAML** + **一个 `.env`**。改完任何一项都要重跑 `npm run dev` 确认合法 —— **配置非法时程序会直接拒绝启动**（这是好事）。

### 3.1 `config/strategy.yaml` — 策略参数（最常改）

```yaml
strategy:
  capital:
    max_lp_ratio: 0.70                      # LP 最多占 NAV 的 70%
    reserve_ratio: 0.30                     # 储备至少占 NAV 的 30%
    initial_strategy_capital_usd: 10000     # ★ 必须改成你的真实总额

  monitor:
    portfolio_interval_minutes: 5           # 组合监控节奏
    pool_scan_interval_minutes: 60          # 池扫描节奏
    pool_health_interval_minutes: 15        # 持仓池健康检查节奏

  range:
    lower_ratio: 0.85                       # 区间下界 = 当前价 × 0.85
    upper_ratio: 1.16                       # 区间上界 = 当前价 × 1.16

  yield:
    target_net_apr: 0.15                    # 目标净 APR
    warning_net_apr: 0.12                   # 低于此值并持续 72h → 判定表现不佳
    warning_duration_hours: 72

  pool:                                     # §16 池「准入」门槛（池够不够深）
    min_tvl_usd: 500000
    min_avg_daily_volume_7d: 250000
    min_age_days: 7
    max_nav_deviation: 0.01
    max_swap_price_impact: 0.005            # 0.5%

  swap:                                     # §40 单笔「执行」容忍度（这一次允许多少滑）
    max_slippage: 0.003                     # 0.3%
    max_price_impact: 0.005                 # 0.5%
    quote_ttl_seconds: 30

  pool_overrides:                           # 按池放宽执行容忍度（key = chainId:dex:poolAddress）
    "56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693":
      max_slippage: 0.008                   # 0.8%（要 1% 就改 0.01）
      max_price_impact: 0.008

  risk:
    max_drawdown: 0.15                      # 总资产跌到初始 × 85% → 全局停机
    peg_warning: 0.01
    stop_new_position: 0.02
    exit_review: 0.03
    emergency_exit: 0.05
    min_reserve_before_new_lp: 0.25         # 储备低于 25% → 禁止新增 LP

  fees:
    auto_compound: false                    # V1 恒为 false
    min_collect_usd: 100                    # 未领取手续费达到此额 → 自动收取
    collect_interval_days: 30

  approvals:
    build_position: confirm                 # 建仓需人工确认
    switch_pool: confirm                    # 换池需人工确认
    others: auto                            # 收手续费 / 风控退出 = 自动
    timeout_minutes: 30                     # 超时未答 → 请求过期，不执行

  telegram:
    enabled: false                          # ★ 开启确认通道时才改 true

whitelist:
  chains: [56]
  dexes:
    - { chainId: 56, dex: pancakeswap-v3 }
    - { chainId: 56, dex: uniswap-v3 }
```

**两个最容易改错的参数：**

- **`initial_strategy_capital_usd`**：直接决定全局风控线（`NAV ≤ 该值 × 85%` 即停机）。**填大了风控形同虚设；填小了立刻停机。**
- **`max_lp_ratio` / `reserve_ratio`**：两个加起来必须 ≤ 1，否则启动报错。

### 3.2 `config/tokens.yaml` / `config/stablecoins.yaml` — 合约白名单

**按合约地址**匹配，不按符号。同一条链上存在同名异物（`QQQB` / `QQQx` / `QQQon` 以及伪装成 `QQQB` 的地址），因此程序**没有**"按名字找地址"的能力 —— 这是有意的。

要新增标的，**必须填官方合约地址**，并显式写 `decimals`；新地址默认 `auto_trade: false`（只监控不交易）。

### 3.3 `.env` — 运行期凭据

```bash
cp .env.example .env
chmod 600 .env
```

| 变量 | 必填 | 说明 |
|---|---|---|
| `STRATEGY_WALLET_ADDRESS` | 只读监控时必填 | 监控哪个地址；**有签名器时以签名器地址为准** |
| `KEYSTORE_PATH` | 否 | 默认 `secrets/wallet.enc` |
| `BSC_RPC_URL` / `BSC_RPC_URL_SECONDARY` | 建议 | 留空则用公共 RPC。**生产建议填两个**（程序会在两个端点间做一致性交叉校验） |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_ALLOWED_USER_IDS` | 实盘必填 | 见 §6 |
| `DRY_RUN` | ★ | `1` = 不发送任何交易（默认）；`0` = 允许真实交易 |
| `LP_DB_PATH` | 否 | 默认 `data/lptrader.db` |

**`.env` 永远不要提交、不要贴给别人、不要写进工单。**

---

## 4. 启动前检查（每次动真钱之前都做一遍）

这四步**全部免费、全部只读**，跑完再决定要不要真跑。

```bash
npm run dev             # ① 配置与白名单自检（不连链）
npm run smoke:read      # ② 链上只读：池状态、余额、bStock 换算系数
npm run smoke:quote     # ③ 真实报价：1000 USDT 能换多少标的
npm run dry-run:build -- 7000
                        # ④ 完整建仓决策链：计划 / 报价 / 闸门 / calldata —— 不发送
```

**期望与判读：**

| 命令 | 期望输出 | 异常时看什么 |
|---|---|---|
| `dev` | 打印链、DEX、可交易股票、稳定币优先级、风控线、审批策略 | 直接报错退出 = 配置非法，按提示改 YAML |
| `smoke:read` | 末尾 `verdict: all required reads succeeded` | RPC 不通；或某 token 探测失败 |
| `smoke:quote` | 有 `amountOut`、`priceImpact`、`§40 gate ok` | 报价失败 = 池地址/Quoter 问题 |
| `dry-run:build` | 每个候选池一段计划 + `RESULT PASS/REJECTED` | 见 §8 判读指南 |

`dry-run:build` 的参数是**你要投入 LP 的金额**（不是总资金）。

> **扫描类命令慢是正常的。** 数据源有速率限制（约 6 秒/次），`smoke:scan` 一轮约 **3 分钟**。**不要**为了跑快去调低限流 —— 那些限流是实测撞过 429 之后设的。

---

## 5. 日常运行

### 5.1 前台试跑

```bash
npm run dev
```

### 5.2 长驻运行（`systemd` 示例）

```ini
# /etc/systemd/system/lptrader.service
[Unit]
Description=lptrader - tokenized stock LP strategy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=lptrader
WorkingDirectory=/opt/lptrader
EnvironmentFile=/opt/lptrader/.env
ExecStart=/usr/bin/node --experimental-strip-types src/main.ts
Restart=on-failure
RestartSec=30
# 硬性要求：重启不能导致重复发交易，程序自身由幂等键保证；
# 但请勿用 Restart=always 掩盖反复崩溃。
StandardOutput=append:/var/log/lptrader/stdout.log
StandardError=append:/var/log/lptrader/stderr.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lptrader
sudo systemctl status lptrader
journalctl -u lptrader -f
```

**重启是安全的**：程序启动时会检查上次是否留下未完成的交易（状态 `CREATED`/`SUBMITTED`/`UNKNOWN`），只会去链上**查询确认**，**不会重发**。

### 5.3 运行期数据与备份

| 路径 | 内容 | 备份 |
|---|---|---|
| `data/lptrader.db` | 仓位、交易记录、决策日志、审批记录、bot 状态 | **建议每日备份**（体积小，直接复制即可） |
| `data/lptrader.db-wal` | SQLite WAL | 备份时一并复制 |
| `secrets/wallet.enc` | 加密私钥 | **必须备份**；丢了等于丢了签名能力 |
| `.env` | 凭据与开关 | **必须离线备份**（含 Bot token，属敏感信息） |

口令（passphrase）**不在任何文件里** —— 请单独用密码管理器保存。**口令丢了，私钥无法恢复。**

### 5.4 日志与告警

- 进程日志：`stdout.log` / `stderr.log`（或 `journalctl`）
- **重要事件会推到 Telegram**：风控线触发、脱锚、池子流动性崩塌、交易失败、审批请求
- 启动时若发现上次有未完成的交易，会推一条 `warning` 提醒需要人工核查

---

## 6. Telegram 审批通道（**实盘的前提**）

在 Telegram 里找 **@BotFather** → `/newbot` → 得到 bot token。
再找 **@userinfobot** → 得到你的 user id。
给 bot 发一条消息，然后从 `https://api.telegram.org/bot<token>/getUpdates` 里取 `chat.id`。

写入 `config/strategy.yaml`（`telegram.enabled: true`）与 `.env`：

```bash
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=你的chat_id
TELEGRAM_ALLOWED_USER_IDS=你的user_id     # 逗号分隔可多人；只有白名单内的人能点确认
```

**验证：**

```bash
npm run telegram:check
```

**输出应为**（未配置时）：

```text
  notifier      : noopNotifier (contract fail-closed)
  approval probe: approved=false (expected false)
  conclusion    : BUILD_POSITION and SWITCH_POOL are blocked (fail closed).
```

**这是正确行为**：没有通道 ⇒ **任何建仓/换池都会被拒绝**，而不是降级为自动执行。反之，若你配好了 token 却仍看到 `noopNotifier`，说明变量名或 `enabled` 写错了。

### 6.1 哪些操作需要你点确认

| 操作 | 需要确认？ | 说明 |
|---|---|---|
| **建仓**（首次把资金放进池子） | ✅ 需要 | 会推送区间、金额、滑点、价格影响 |
| **换池** | ✅ 需要 | 同上 |
| 收取手续费 | ❌ 自动 | §63，收进储备 |
| 风控退出 / 停机 | ❌ 自动 | **故意不设人工门** —— 危险时刻不该等人 |
| 持仓监控、池扫描、告警 | ❌ 自动 | |

请求 **30 分钟**（`timeout_minutes`）未答即过期，**过期后不执行**。

### 6.2 可用查询命令

`/status`、`/position`、`/pools`、`/nav`、`/risk`

---

## 7. 从零到实盘：完整顺序

```bash
# ── 阶段 A：只读（不需要私钥、不花钱）──────────────────
npm run dev                                       # 配置自检
npm run smoke:read                                # 链上只读验证
npm run smoke:quote                               # 报价验证

# ── 阶段 B：配好参数与地址 ─────────────────────────────
# 1. 改 config/strategy.yaml：initial_strategy_capital_usd ← 你的真实总额
# 2. cp .env.example .env && chmod 600 .env
# 3. 填 STRATEGY_WALLET_ADDRESS；DRY_RUN 保持 1
npm run dev                                       # 再确认一次
npm run smoke:scan                                # 看清当前哪些池合格（约 3 分钟）

# ── 阶段 C：看"如果真建仓会长什么样"─────────────────────
npm run dry-run:build -- <你的LP金额>              # 必须读懂输出，见 §8

# ── 阶段 D：接审批通道 ─────────────────────────────────
# BotFather 建 bot → 填 .env 三个变量 → strategy.yaml 里 telegram.enabled: true
npm run telegram:check                            # 确认通道可用

# ── 阶段 E：生成签名钱包（开始碰真钱）──────────────────
npm run keystore:init                             # 交互输入口令；生成 secrets/wallet.enc
# ⚠ 用独立钱包，只放允许亏掉的资金；钱包里备少量 BNB 作 gas
# ⚠ 备份 wallet.enc 与口令（分开保存）
# ⚠ 此时 DRY_RUN 仍建议为 1，再跑一次 dry-run:build 确认

# ── 阶段 F：小额实盘 ───────────────────────────────────
# 1. initial_strategy_capital_usd 设成第一笔真实金额
# 2. .env 里 DRY_RUN=0
# 3. 启动 → 扫描 → 建仓前 Telegram 弹出确认 → 你核对数字 → Approve
```

**阶段 F 之前的每一步都不花钱。请务必走完 C。**

---

## 8. `dry-run:build` 输出判读

这是最重要的一个命令：它告诉你"现在真建仓会长什么样"。

```text
candidate 56:pancakeswap-v3:0xe531fcb1...
  dex / feeTier                    pancakeswap-v3 / 100
  tvl / vol24h                     $575822 / $6306616
  tick / tickSpacing               66041 / 1
  supportsAtomicBuild (§42)        true

  position plan (§33-§38)
  §3 allocation                    OK — LP 4900.00 of NAV 7000.00 (cap 70%), reserve 2100.00
  lowerPrice / upperPrice          627.7164 / 856.6482
  lowerTick / upperTick            64424 / 67533
  ticks aligned (§34)              true
  value token0 USD                 2342.57
  value token1 USD                 2557.43
  value sum USD                    4900.00
  swap needed (§38)                2345969731642672503127 raw
  optimal vs fixed 50/50           4.385% (2342.57 vs 2450.00)

  quote + §40/§41 gates
  amountOutRaw                     3176218456364638925
  priceImpact (adapter)            0.015547%
  priceImpact (independent)        0.015547%
  impact agreement                 agree (delta 2.09e-7, tolerance 1.56e-6 = 1% of impact)
  §40 limits in force              slippage 0.80% / impact 0.80%
  §40 gate ok                      true
  shortfall/surplus (QQQB)         -0.0100% (-524868665150623 raw)
  funding verdict                  within 1% of the plan — expected
  RESULT                           PASS — a live build would proceed to the approval gate
  atomicity (§42)                  single transaction (swap + mint combined)
```

**必须逐项核对：**

| 字段 | 看什么 | 不对时的含义 |
|---|---|---|
| `§3 allocation` | `LP = NAV × max_lp_ratio`，reserve 补齐 | 你参数填错，或资金与 `initial_strategy_capital_usd` 不符 |
| `lowerPrice / upperPrice` | ≈ 当前价 × 0.85 / ×1.16 | 区间推导错 |
| **`ticks aligned`** | **必须 `true`** | `false` = 会在 swap 之后 revert（先花钱后失败） |
| `value sum USD` | **必须精确等于**你的 LP 金额 | 求解器超募或欠募 |
| **`optimal vs fixed 50/50`** | **非 0**（正常 3–5%） | 若为 0 = 退化成固定 50/50（这是核心错误方案） |
| `priceImpact` 两行 | **`impact agreement` 必须 `agree`** | `DISAGREE` = 本地影响计算与独立复算不一致，**不要建仓** |
| `§40 limits in force` | 是否按你的 `pool_overrides` 生效 | 覆盖没生效 = 配置没读到 |
| `shortfall / funding verdict` | 在 1% 内属正常（中间价求解 vs 实际付费成交） | 大幅偏离 = 求解器有问题 |
| **`atomicity`** | Pancake = 单笔；Uniswap = 两笔 | 单笔更好（两笔之间价可能变，且可能只成交一半） |

**出现了 `ticks aligned: false`、`DISAGREE`、`optimal vs fixed 50/50: 0`，或 `value sum` 明显偏离 —— 停下来，不要建仓。**

---

## 9. 排障

| 症状 | 原因 | 处理 |
|---|---|---|
| `STARTUP ABORTED (fail closed)` | 配置非法 / 白名单为空 / keystore 结构损坏 | 看紧跟其后的错误信息，按提示改 |
| 建仓/换池一直没发生 | **Telegram 未配置**（最常见） | `npm run telegram:check`；见 §6 |
| 所有池都是 `REJECT`，`decisive false` | 数据源拿不到某个字段（如 7d 量、链上 impact） | 看 `reasons`：`*_UNAVAILABLE` = 数据缺失，不是池不合格；稍后重试或换 RPC |
| `Cannot find module` | 依赖未装 / 路径不对 | `npm ci`；确认在仓库根执行 |
| `cross-check failed ... slot0` | 两个 RPC 端点不一致 | 多为区块不同步；程序已固定区块高度。持续报错则换 RPC 端点 |
| `ExperimentalWarning: SQLite` | Node 内嵌 SQLite 的实验性提示 | **可忽略**（功能正常） |
| 扫描很慢（3 分钟） | 数据源限流（6 秒/次） | **正常**，不要调低限流 |
| 进程反复重启 | 配置错 / RPC 全挂 | `journalctl -u lptrader -n 200`；**不要**用 `Restart=always` 掩盖 |
| 启动时收到"有未完成交易"告警 | 上次崩溃时有交易在途 | **按提示去链上核查**，程序不会自动重发；确认状态后再决定 |

### 9.1 紧急停止

```bash
sudo systemctl stop lptrader        # 停进程
```

**注意**：停进程**不会**自动撤出资金。链上仓位仍在池子里继续赚取/承担无常损失。

- 要**撤出仓位**：用 Telegram 的 `/status` 看状态，或在重新启动后由风控路径处理；也可直接在 PancakeSwap 前端手动移除该 NFT 仓位（仓位归你的钱包所有）。
- `data/lptrader.db` 里有仓位记录（`positions` 表），含 tokenId 与区间。

### 9.2 回滚

无数据库迁移，回滚 = 切回上一个 git 版本 + `npm ci`。`data/lptrader.db` 保持兼容（迁移是只增不改的顺序编号）。

---

## 10. 安全清单（部署后逐条打勾）

```text
[ ] Node >= 22.6.0，npm ci 成功，npm test 全绿
[ ] git check-ignore secrets/wallet.enc .env data/lptrader.db 三条都有输出
[ ] git ls-files 与实际文件数一致（逐目录核对）
[ ] .env 权限 600，secrets/ 权限 700
[ ] 实盘钱包是**独立钱包**，只放允许亏损的资金
[ ] wallet.enc 与口令分别备份（且不在同一台机器上）
[ ] 有 ≥ 2 个 RPC 端点配置
[ ] Telegram ALLOWED_USER_IDS 只含可信用户
[ ] DRY_RUN 在首次实盘前确认为 1，跑完 dry-run:build 再改为 0
[ ] 系统时间已同步（NTP）
[ ] 已读懂 §8 的判读表
```

---

## 11. 明确的能力边界（避免误解）

**已实现并实测**：链上只读读取、bStock 换算系数运行期获取、三层数据源扫描与硬性过滤、集中流动性建仓数学（非固定 50/50）、报价与滑点/价格影响闸门、按池可配的执行容忍度、按比例的资金分配校验（结果态）、组合 NAV 与回撤、脱锚五档 / TVL 崩塌 / 储备下限 / 全局风控线、仓位退出、收取手续费、Telegram 双向确认、幂等与交易状态机、调度。

**未实现（已知，勿期待）**：

- **自动换池**（基线 Phase 5）—— 本迭代只到单池建仓/监控/退出
- **回测与多周纸上交易**（§101/§102）
- **程序化金额阶梯** —— 用户裁定改为手动加资金 + 严格按比例执行
- **BEP-677 企业行动自动停摆**（拆股/分红等 ex-date）—— 换算已闭环，但"检测到事件后在窗口内暂停"未实现。**遇到标的要拆股/分红，请手动停机**（见 `docs/known-issues.md` KI-26）
- **新机器上的开机自启**已由 §5.2 覆盖，但**没有**内置监控/看护进程

**每次决策都可审计**：为什么建仓、为什么拒绝、为什么退出，都落在 `data/lptrader.db` 的决策日志里。

---

## 12. 速查卡

```bash
# 部署
git clone <repo> && cd lptrader && npm ci && npm run typecheck && npm test

# 配置
vi config/strategy.yaml      # ★ initial_strategy_capital_usd
cp .env.example .env && chmod 600 .env

# 检查（免费）
npm run dev                  # 配置自检
npm run smoke:read           # 链上只读
npm run smoke:quote          # 报价
npm run smoke:scan           # 扫描 + 过滤（约 3 分钟）
npm run dry-run:build -- <LP金额>   # ★ 建仓预演

# 审批通道
npm run telegram:check

# 私钥（开始碰真钱）
npm run keystore:init        # --force 覆盖已有

# 运行
npm run dev                  # 前台
sudo systemctl start lptrader

# 排障
journalctl -u lptrader -f
sqlite3 data/lptrader.db "select * from decision_logs order by timestamp desc limit 20;"
```

**遇到无法解释的现象：先停（`systemctl stop`），保留 `data/lptrader.db` 与日志，再排查。** 停机的代价远小于带着错误状态继续交易。

---

# 第二部分 · 日常使用

## 1. 一分钟理解它怎么运作

```text
每 5 分钟   看你的钱：钱包余额 + 仓位价值 + 未领手续费 → 算 NAV → 对比例、查风控
每 15 分钟  看持仓池的健康（区间位置、流动性）
每 1 小时   扫全市场：哪些池够深够安全 → 硬性门槛筛掉不合格的
持续        脱锚 / TVL 崩塌 / 回撤超线 → 告警；严重时自动退出并停机
```

**它会自己做**：收取手续费、按风控退出、停机、告警、扫描、监控。
**它必须问你**：建仓、换池。
**它不做**：复投、补仓、追涨、频繁调仓、自动加资金。

**它信不过就停手**，不会猜。读不到价格、读不到链上状态、报价过期 —— 一律拒绝等你处理。**看到"没动静"多数是它主动拒绝，不是坏了。**

---

## 2. 每天要看的东西

### 2.1 Telegram（主要入口）

| 命令 | 看什么 |
|---|---|
| `/status` | 当前状态、是否只读模式、审批策略、风控线 |
| `/nav` | 总资产、储备、LP 价值、收益 |
| `/position` | 持仓池、区间、当前价在区间的哪个位置、手续费 |
| `/pools` | 当前合格池 |
| `/risk` | 脱锚偏差、储备比例、TVL、回撤 |

**主动推送**（不用你问）：风控触发、脱锚告警、池子流动性崩塌、交易失败、以及**需要你确认的请求**。

### 2.2 公告级别与你的动作

| 级别 | 含义 | 你要做什么 |
|---|---|---|
| `info` | 常规进展 | 不用管 |
| `warning` | 需要留意（数据源降级、估值不完整、确认请求过期） | 抽空看一眼 |
| `critical` | 严重（脱锚、TVL 崩塌、触及风控线、交易失败） | **立刻看**，必要时停机（§6） |

---

## 3. 确认请求：你会看到什么，怎么判断

建仓或换池前，Telegram 会收到一条带 **Approve / Reject** 按钮的消息，正文类似：

```text
BUILD pancakeswap-v3 56:pancakeswap-v3:0xe531fcb1...
capital $4900.00
price $735.2118
range $627.72 – $856.65
ticks 64424 → 67533
swap 2345969731642672503127 raw
impact 0.0155% (max 0.80%)
slippage 0.80%
```

**点数之前核对这几项：**

| 项 | 应该是什么 | 不对就别点 |
|---|---|---|
| `capital` | 你预期的 LP 金额（= 总额 × `max_lp_ratio`） | 金额不对 → 参数或资金填错 |
| `price` | 与当前市场价接近 | 差很多 → 数据源有问题 |
| `range` | ≈ 价格 × 0.85 / ×1.16 | 区间异常 → 别建 |
| **`ticks`** | 两个整数，且是池的 tickSpacing 整数倍 | 不整齐 → 会在 swap 后失败 |
| `impact` | 小于括号里的 `max` | 超了说明本不该走到这一步，**别点** |
| `slippage` | 你配置的值（默认 0.3%，按池可能 0.8%/1%） | 与预期不符 → 检查 `pool_overrides` |

**30 分钟不答 = 自动过期，什么都不做。** 这是安全的默认，不是失败。

**不确定就不要点。** 宁可让它过期 —— 过期只是"这一轮没建仓"，点错是"钱进了不该进的池"。

### 想改容忍度（例如某池放到 1%）

改 `config/strategy.yaml`：

```yaml
  pool_overrides:
    "56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693":
      max_slippage: 0.01          # 1%
      max_price_impact: 0.01
```

改完**必须重跑** `npm run dev` 验证，再重启进程。

**注意**：执行容忍度**不能低于**池的准入门槛（`pool.max_swap_price_impact`，默认 0.5%）。准入更严、执行更松才合理；反过来程序会在启动时直接拒绝。

---

## 4. 加资金（你手动做，程序只监控）

程序**不会**自己加资金（§68）。你的动作：

1. **把钱转进策略钱包**（USDT 或 USDC；另备少量 BNB 作 gas）
2. **改 `config/strategy.yaml` 的 `initial_strategy_capital_usd`** = 你打算投进策略的**总额**
3. **重启进程**：`sudo systemctl restart lptrader`
4. **看 Telegram `/nav` 与 `/status`**，确认新 NAV 被读到

### 为什么必须改 `initial_strategy_capital_usd`

它直接决定风控线：`NAV ≤ 该值 × 85%` → 全局停机。

| 情况 | 后果 |
|---|---|
| 填**大**了（写 10000，实际只投 500） | 风控线算成 8500，**永远不触发** → 亏光也不停 |
| 填**小**了 | 一启动就判定"已跌破风控线"，立刻停机 |

**这个数字不是仪式，是保险丝。**

### 加钱之后程序怎么反应

- 比例会**漂移**（LP 占比可能低于 `max_lp_ratio`，储备高于 `reserve_ratio`）
- 程序**只监控并告警**，**不会**自动把多出来的储备投进池子
- 储备高于目标**不算错** —— 那是未部署资金，§4 明确禁止自动投进去
- 想让新资金也去赚，需要**新一轮建仓**（会再走一次确认门）

---

## 5. 收益与手续费

- **不自动复投**（V1 恒为 `auto_compound: false`）
- **自动收取**：未领取手续费 ≥ **$100**，或满 **30 天** → 自动 collect，进储备
- 收到的是稳定币 → 直接进储备；收到的是股票代币 → 按配置条件换成稳定币再进储备
- 逻辑上分两笔账：**本金储备** vs **已赚取的部分**（Profitable Vault）

看收益：`/nav` 里看总资产与已实现手续费。**判断赚不赚要扣除"股票本身涨跌"** —— 程序内置基准（建仓时同比例的买入持有），差值才是 LP 的真实贡献。

---

## 6. 什么时候必须手动停机

| 情况 | 动作 |
|---|---|
| 标的要**拆股 / 分红**（ex-date） | **提前停机**。企业行动会暂停交易，而"自动在事件窗口内停摆"未实现（见 `docs/known-issues.md` KI-26） |
| 收到 `critical` 告警但不确定含义 | 先停，再查 |
| 发行方 / 合规 / 赎回出现任何异常消息 | 先停 |
| 你要动策略钱包里的钱 | 先停，避免程序同时在建仓 |
| 系统行为与这份文档不符 | 先停，保留 `data/lptrader.db` 与日志，再排查 |

```bash
sudo systemctl stop lptrader
```

**停机的代价远小于带着错误状态继续交易。**

**注意**：停机**不会**自动撤出资金 —— 链上仓位仍在池子里继续赚取/承担无常损失。仓位 NFT 归你的钱包所有，需要时可以在 PancakeSwap 前端手动移除。

**风控退出是自动的**：触及回撤线（NAV ≤ 初始 × 85%）、脱锚、TVL 崩塌时，程序会自行退出并停机，**不会等你**。这是有意的 —— 危险时刻不该等人。

---

## 7. 常见疑问

**Q：跑了半天一笔没建，是不是坏了？**
看 `/pools` 和启动时的扫描输出。最常见两种原因：① **Telegram 没配好**，建仓被确认门挡住（`npm run telegram:check` 确认）；② **当前没有池通过硬性门槛**（`decisive false` 表示是数据缺失，不是池子不合格）。

**Q：为什么有的池一会儿合格一会儿不合格？**
准入门槛里的"3500 美元换手的价格影响"是**实时指标**，随池子流动性波动。**不要**把"某个池能做"当成固定结论记住。

**Q：它为什么不把储备也投进去赚更多？**
设计如此。储备是防异常退出、付 gas、重建仓位用的，§4 明确禁止因 APR 上升自动投入。

**Q：价格出了区间会怎样？**
- 出**上界**：仓位逐渐变成稳定币。**不追涨**，记录、等待、重新扫池。
- 出**下界**：仓位逐渐变成股票代币。**不自动卖**，转人工风险复核。
- 接近边界：只**告警**，不操作。

**Q：它会频繁调仓吗？**
不会。V1 **禁止**区间内重新居中 —— 频繁调仓会制造已实现无常损失、swap 成本、滑点和 gas。

**Q：我怎么知道它某天为什么做了某个决定？**
所有决策落在 `data/lptrader.db` 的 `decision_logs`：

```bash
sqlite3 data/lptrader.db "select timestamp, action, result, reason from decision_logs order by timestamp desc limit 20;"
```

**Q：`noopNotifier` / `fail closed` 是什么意思？**
"通道不可用 ⇒ 拒绝执行"。没有 Telegram 时它**拒绝**建仓，而**不是**降级成自动执行 —— 沉默绝不被当成许可。

---

## 8. 想调整策略参数

改 `config/strategy.yaml`，然后 `npm run dev` 验证 + 重启。常改的几项：

| 想做的事 | 改哪里 |
|---|---|
| 改区间宽窄 | `range.lower_ratio` / `upper_ratio`（默认 0.85 / 1.16） |
| 放松/收紧滑点 | `swap.max_slippage` / `max_price_impact`；某池特殊 → `pool_overrides` |
| 改池准入门槛 | `pool.min_tvl_usd` / `min_avg_daily_volume_7d` / `max_swap_price_impact` |
| 改风控线 | `risk.max_drawdown`（0.15 = 跌 15% 停机） |
| 改监控频率 | `monitor.portfolio_interval_minutes` 等 |
| 改手续费收取门槛 | `fees.min_collect_usd` / `collect_interval_days` |
| 加/减可交易标的 | `config/tokens.yaml`（**必须用官方合约地址**） |

**改任何 `risk` 阈值前先想清楚后果** —— 例如把 `max_drawdown` 放宽（0.15 → 0.30），意味着允许亏到 70% 才停机。

---

## 9. 交给别人或换机器

需要带走的（可恢复运行的最小集合）：

1. **代码**（git 仓库）
2. **`config/` 三个 YAML**（策略参数 + 白名单）
3. **`.env`**（凭据与开关）—— 敏感，离线传递
4. **`secrets/wallet.enc`** —— 加密私钥；**丢了就要重建钱包**
5. **口令（passphrase）** —— 不在任何文件里，**丢了私钥无法恢复**
6. `data/lptrader.db` —— 可选；带上可保留仓位与决策历史

**不要**把 `.env`、`wallet.enc`、口令放进 git、聊天工具或工单。

新机器上的安装步骤见 `OPS.md` §2。

---

## 10. 速查卡

```bash
# 看状态
npm run dev                          # 配置/白名单自检
npm run telegram:check               # 审批通道是否可用

# 看市场（免费）
npm run smoke:read                   # 链上只读
npm run smoke:quote                  # 报价
npm run smoke:scan                   # 哪些池合格（约 3 分钟）
npm run dry-run:build -- <LP金额>     # ★ 建仓预演：真建仓会长什么样

# 运行
sudo systemctl start lptrader
sudo systemctl stop lptrader         # ★ 不确定时就停
journalctl -u lptrader -f

# 查历史决策
sqlite3 data/lptrader.db "select timestamp, action, result, reason from decision_logs order by timestamp desc limit 20;"

# 备份
cp data/lptrader.db* /你的备份目录/ && cp -r secrets /你的备份目录/ && cp .env /你的备份目录/
```

**不确定就停。** 停机的成本是少赚一会儿；带着错误状态交易的代价可能是真金白银。
