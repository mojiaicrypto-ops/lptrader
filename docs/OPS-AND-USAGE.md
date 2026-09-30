# lptrader 综合文档（部署运维 + 日常使用）

**一份读到底的版本**，内容为 `OPS.md`（新机器部署与运维）与 `USAGE.md`（日常使用）的合并。
想分读：部署看 `OPS.md`，日常看 `USAGE.md`。**从零开始请直接跳 §7 可执行顺序。**

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
| **BSC RPC** | **可留空**（用已验证的公共默认端点）；若要自备，见下方警告 | 见 §3.3 的 RPC 注意事项 |
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
| `BSC_RPC_URL` / `BSC_RPC_URL_SECONDARY` | 建议 | **留空 = 用已验证的公共默认端点**（`bsc-dataseed.bnbchain.org` + `bsc-rpc.publicnode.com`）。**生产建议填两个** —— 程序会在两个端点间做一致性交叉校验（§99）。⚠️ 见下方 RPC 警告 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` / `TELEGRAM_ALLOWED_USER_IDS` | 实盘必填 | 见 §6 |
| `DRY_RUN` | ★ | `1` = 不发送任何交易（默认）；`0` = 允许真实交易 |
| `LP_DB_PATH` | 否 | 默认 `data/lptrader.db` |

**`.env` 永远不要提交、不要贴给别人、不要写进工单。**

#### ⚠️ RPC 选择：三个实测过的坑

**坑 1：Infura 不支持 BNB Chain 的完整 JSON-RPC。** 实测 `eth_gasPrice` 返回
`An internal error was received`。它的 BSC 端点 URL 看起来正常、部分方法也能通，于是很容易
误以为配对了，直到某个调用失败：

```text
eth_gasPrice could not be served by any RPC endpoint (1 tried): ... An internal error was received
```

**修法**：把这个变量**留空**用公共默认端点，或换成真正支持 BSC 的 provider
（如 Alchemy / Ankr / NodeReal，或自建节点）。

**坑 2：key 在 URL 路径里 → 报错会连 key 一起打出来。** 形如
`https://.../v3/<key>` 的地址，出错时 viem 会把整条 URL 打进错误文本，于是**终端、journal、
告警里都是你的 key**。

已修：程序现在会把错误文本里的 URL 脱敏成 `https://host/v3/<redacted>`（保留 host 便于排查，
去掉凭据）。但有测试覆盖 ≠ 鼓励把 key 放在路径里 —— 能用 Header 认证的 provider 更安全。

> **如果你曾经把带 key 的错误输出贴给任何人（包括贴进对话），请去 provider 控制台 rotate 该 key。**

**坑 3：只配一个端点 = 单点故障。** 生产环境请配两个：程序会对关键读取做一致性交叉校验
（§99），并且在主端点失败时自动切换。

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
| `secrets/wallet.enc` | 加密私钥 | **必须备份** —— 完整做法与恢复演练见 §5.5 |
| `.env` | 凭据与开关 | **必须离线备份**（含 Bot token，属敏感信息） |

**私钥备份是本项目最要紧的一件事，单独成节：见 §5.5。** 一句话版本：口令不在任何文件里，所以**只备份 `wallet.enc` 是不够的** —— 还要把私钥本身抄下来，并**实际验证一次能恢复**。

### 5.4 日志与告警

- 进程日志：`stdout.log` / `stderr.log`（或 `journalctl`）
- **重要事件会推到 Telegram**：风控线触发、脱锚、池子流动性崩塌、交易失败、审批请求
- 启动时若发现上次有未完成的交易，会推一条 `warning` 提醒需要人工核查

### 5.5 私钥的备份与恢复

**这是整份文档里最需要认真对待的一节。** 钱包私钥是唯一能证明"这钱是你的"的东西，而且**没有找回机制** —— 没有客服、没有邮箱重置、没有"忘记密码"。

#### 先理解三样东西，以及各自丢了会怎样

| 东西 | 是什么 | 丢了会怎样 | 谁看过它 |
|---|---|---|---|
| **私钥**（64 位十六进制，`0x` 开头） | 钱包的全部控制权 | **资产永久丢失**，无任何找回途径 | 只有你 —— 程序只在内存里短暂持有 |
| **口令（passphrase）** | 解开 `wallet.enc` 的密码 | `wallet.enc` 变成废纸；**但如果你另外存了私钥，仍能恢复** | 只有你 —— **不保存在任何文件里** |
| **`secrets/wallet.enc`** | 用口令加密后的私钥（AES-256-GCM） | 用私钥＋口令重建即可 | 放在磁盘上，本身不构成泄露（没有口令解不开） |

**关键推论：最保险的备份是"私钥本身"，因为口令丢了它也能救你。** `wallet.enc` 是方便日常运行的，不是终极备份。

#### 备份：两条路线，建议都做

**路线 A（必须）：离线抄下私钥** —— 这是唯一不依赖口令的备份。

```bash
npm run keystore:verify -- --export
```

会要求你输入口令，然后要求你**手打 `EXPORT`** 确认（防止手滑把私钥打到屏幕上）。之后打印私钥。

**然后按这个顺序做：**

1. **抄到纸上**（或金属助记板）—— 两份，放**两个不同的物理位置**（如家里 + 保险柜/银行）
2. **或存进密码管理器**（1Password / Bitwarden 等），并确保它有云端备份
3. **立刻清屏**：`clear`（若终端有 scroll-back，也要清）
4. **确认没有录音、投屏、共享会话**

> **不要**把私钥贴进聊天工具、工单、截图、云笔记、邮件。这些地方都会被索引或被别人看到。

**路线 B（建议）：复制加密文件** —— 日常恢复用，方便但要配合口令。

```bash
cp -p secrets/wallet.enc /你的备份位置/wallet.enc
```

- 记录**创建时的 `KEYSTORE_CHAIN_ID`**（默认 56），恢复时必须一致
- **口令单独保存**在密码管理器里 —— **绝不**和 `wallet.enc` 放在同一处
- 可以用 U 盘/离线介质，但注意 U 盘也会坏，**别只留一份**

**路线 B 的盲区（务必知道）**：文件损坏、口令记错、chain id 记错，任何一个都会让你打不开它。所以**路线 A 才是真正的保险**。

#### **备份做完必须验证** —— 没验证过的备份不算备份

这是本节的要点。很多人备份完从没试过恢复，真出事时才发现打不开。

```bash
npm run keystore:verify
```

**期望输出：**

```text
Verification PASSED. The passphrase decrypts this keystore.
  address : 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
```

**把打印出的 `address` 和你创建时记录下的地址（或钱包 App 里显示的地址）逐字符比对。** 一致 = 备份可用。

默认模式下**不会打印私钥**，只打印地址 —— 因为地址足以证明"文件能解开、而且解出来的是这个钱包"，同时不会把私钥留在屏幕上。

> **建议**：备份后的**当天**做一次完整恢复演练（下一小节），并且**每隔几个月重做一次**验证 —— 介质会老化，记忆会模糊。

#### 恢复：三种场景

**场景 1：同一台机器，文件被误删 / 需要重建**

```bash
mkdir -p secrets && chmod 700 secrets
cp -p /你的备份位置/wallet.enc secrets/wallet.enc
chmod 600 secrets/wallet.enc
npm run keystore:verify            # 用口令验证
```

**场景 2：换到新机器**

```bash
# 1) 先按 OPS.md §2 部署代码并 npm ci
# 2) 放回密钥与配置
mkdir -p secrets && chmod 700 secrets
cp -p /你的备份位置/wallet.enc secrets/wallet.enc
chmod 600 secrets/wallet.enc
cp /你的备份位置/.env .env && chmod 600 .env
# 3) 确认 .env 里的 KEYSTORE_PATH / KEYSTORE_CHAIN_ID 与创建时一致
# 4) 验证
npm run keystore:verify
```

**场景 3：没有 `wallet.enc`，只有私钥（最需要预案的情况）**

```bash
npm run keystore:init              # 输入私钥 + 设置（新）口令
```

重新生成 `wallet.enc`。**地址会与原来完全一致**（私钥相同 ⇒ 地址相同），因此资金、仓位、审批配置都不用动。

> 这种情况正是"路线 A 必须做"的原因 —— 口令忘了、文件坏了，只要私钥在纸上，钱包就还在你手里。

#### 恢复演练（建议在**真正放钱之前**做一遍）

用一个小额钱包走完整流程，确认每一步都通：

```text
1. 创建：      npm run keystore:init                → 记下打印的 address
2. 备份：      npm run keystore:verify -- --export  → 抄下私钥
                cp -p secrets/wallet.enc /tmp/wallet.enc.bak
3. 销毁：      rm secrets/wallet.enc                （模拟丢失）
4. 恢复 A：    npm run keystore:init                → 用抄下的私钥重建
               npm run keystore:verify              → address 必须与第 1 步一致
5. 销毁：      rm secrets/wallet.enc
6. 恢复 B：    cp -p /tmp/wallet.enc.bak secrets/wallet.enc
               npm run keystore:verify              → address 必须与第 1 步一致
7. 收尾：      rm /tmp/wallet.enc.bak
```

**第 4 步和第 6 步的 address 都等于第 1 步，才算你真正拥有一个可用的备份。** 只在纸上抄了却从没验证过，等于没有备份。

#### 验证工具会告诉你具体哪里错了

`npm run keystore:verify` 对不同的失败给出**不同**的处置建议，因为在恢复现场，"口令错"和"文件坏"要采取的行动完全不同：

| 输出 | 含义 | 你该做什么 |
|---|---|---|
| `no keystore at <path>` | 文件不在那儿 | 放回备份；注意 `KEYSTORE_PATH` 是否指对 |
| `was created for a different chain id` | chain id 不一致 | 把 `KEYSTORE_CHAIN_ID` 改回创建时的值（BNB Chain = 56） |
| `decryption failed. Either the passphrase is wrong, or the file is damaged` | 口令错**或**文件被改动 | 先换几个口令试；都不行 → **不要**去手改文件，改用私钥重建（场景 3） |
| `does not match the address stored in the envelope` | 文件被手工编辑过 | 视为可疑，**不要使用**，从备份恢复 |
| `Verification PASSED.` + 地址 | 一切正常 | 比对地址即可 |

#### 安全提醒

- **不要**把私钥写进 `.env`、源码、脚本或任何会被 git 追踪的文件。本项目**只**通过 `wallet.enc` + 交互式口令使用私钥
- **不要**把 `wallet.enc` 和口令放在同一个位置（一份备份泄露不该等于私钥泄露）
- 这个钱包**只放策略允许亏掉的钱**（基线 §92）。它是热钱包，私钥在联网机器上被解密使用
- 换机器 / 交接时，用**离线介质**传 `wallet.enc` 与 `.env`，不要走聊天工具
- 一旦怀疑私钥泄露：**立刻用新钱包转移资金**，重新 `keystore:init`，旧的 `wallet.enc` 删除。链上没有"改密码"这回事

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

## 7. 从零到实盘：可执行顺序

**每一阶段都可以停。** 阶段 0–3 **不花钱、不需要私钥**。阶段 4 才开始碰真钱。

复制命令时请**整段复制**，不要只挑中间几行 —— 顺序本身是约束。

---

### 阶段 0 · 检查 Node（只需一次）

```bash
node -p "process.config.variables.node_use_amaro"
```

**必须输出 `true`。** `false` 或报 `ERR_NO_TYPESCRIPT` = 你这个 Node 构建没编进 TS 支持
（发行版自带的 `nodejs` 包常见），**任何参数都绕不过**，先修环境：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL -l
nvm install 24 && nvm use 24
node -p "process.config.variables.node_use_amaro"    # ← 重新确认 true
which node                                           # ← 必须指向 ~/.nvm/...，不是 /usr/bin/node
```

---

### 阶段 1 · 安装与自检（只需一次）

```bash
cd <仓库目录>
npm ci
npm run typecheck        # 期望：无输出（0 错误）
npm test                 # 期望：25 文件 / 725 测试全部通过
```

**不通过就不要继续。**

---

### 阶段 2 · 建配置文件（不需要私钥）

```bash
cp .env.example .env
chmod 600 .env
npm run dev
```

**期望输出**（关键三行）：

```text
  telegram        : DISABLED — no build or switch can be approved
  keystore        : not configured
  dry-run         : yes (no transaction will be sent)
```

> **`keystore: not configured` 是正常的。** 现在按设计是"只读模式"：能监控、能扫描、能告警，
> 但无法建仓 —— 因为还没有签名钱包。

**此时去改 `config/strategy.yaml`：**

```yaml
strategy:
  capital:
    initial_strategy_capital_usd: <你的真实总额>   # ★ 必改，见 §4
```

改完再跑一次 `npm run dev` 确认没报错。

---

### 阶段 3 · 只读验证（免费，建议全跑）

```bash
npm run smoke:read                          # 链上只读：池状态 / 余额 / bStock 换算
npm run smoke:quote                         # 真实报价 + §40 闸门
npm run smoke:scan                          # 扫全市场 + §16 过滤（约 3 分钟）
npm run dry-run:build -- <你的LP金额>         # ★ 建仓预演：真建仓会长什么样
```

`dry-run:build` 的输出必须按 **§8 的判读表**逐项核对。

**到这里为止不需要私钥、不花一分钱、不连你的钱包。** 建议真的走完再决定要不要继续。

---

### 阶段 4 · 创建签名钱包（**从这里开始碰真钱**）

**两条命令，按你的来源选一条：**

| 你的情况 | 用哪条 | 你要提供什么 |
|---|---|---|
| **还没有钱包，想要一个新的** | `npm run keystore:generate` | **只需输入口令** —— 私钥由程序在本地生成 |
| 已有钱包（硬件钱包/别处导出的私钥） | `npm run keystore:init` | 粘贴你的私钥 + 设置口令 |

#### 推荐：让程序生成（你只输口令）

```bash
npm run keystore:generate
```

交互流程（**口令不回显；私钥全程不显示**）：

```text
Passphrase for the encrypted keystore (hidden):     ← 设置口令，至少 12 字符
Repeat passphrase                    :             ← 再输一遍
```

成功后打印：

```text
Wallet generated, encrypted and verified.

  address : 0xaD4FAbE844BCB296f1aD01ceCbf75865aeEf9f4B     ← ★ 记下这个地址
  file    : /path/to/secrets/wallet.enc (mode 0600)
```

**私钥从哪里来**：`viem.generatePrivateKey()` → `node:crypto` 的 CSPRNG（操作系统熵源）。
**无网络调用**，密钥不离开这台机器，**也不经过任何对话/日志/剪贴板** —— 这正是它比"去某个网站生成再粘贴回来"更安全的地方。

> ⚠️ **代价你必须知道**：生成后，**私钥的唯一副本就在 `wallet.enc` 里**。口令忘了 = 钱包永久丢失。
> 所以脚本最后会要求你做备份（下方第 3 步）。

#### 备选：导入已有私钥

```bash
npm run keystore:init
```

```text
Private key (0x + 64 hex, hidden):        ← 粘贴你的私钥
Passphrase (hidden):                      ← 设置口令
Repeat passphrase  :
```

**先做的四件事（顺序别换）：**

1. **记下打印的 `address`** —— 你要往它转钱，后面验证备份也要用它比对
2. **`chmod 600 secrets/wallet.enc`** —— 脚本已设，但确认一下
3. **备份私钥**（生成器不打印私钥，所以要显式导出一次）：

```bash
npm run keystore:verify -- --export    # 打印私钥 → 抄纸两份 / 存密码管理器 → 清屏
```

4. **解除 `.env` 里的注释**，让程序能找到 keystore：

```bash
# 编辑 .env，把这行的 # 去掉
KEYSTORE_PATH=secrets/wallet.enc
```

然后验证：

```bash
npm run dev
```

**期望**（注意两处变化）：

```text
  keystore        : secrets/wallet.enc
  dry-run         : yes (no transaction will be sent)
```

> **现在仍未开启交易** —— `DRY_RUN=1`。程序能读到密钥，但仍拒绝广播。
>
> **这就是你刚遇到的报错的反面**：如果 `.env` 里设了 `KEYSTORE_PATH` 而文件不存在，启动会
> `STARTUP ABORTED (fail closed): cannot read keystore file ...`。那不是故障，是 fail-closed 设计 ——
> 两种修法：**创建它**（本节），或**注释掉 `KEYSTORE_PATH`** 退回只读模式。

**钱包本身的要求**（§92）：

- **独立钱包**，只放策略允许亏掉的钱；别用主钱包
- 钱包里要有 **USDT 或 USDC**（建仓用）+ **少量 BNB**（gas，几美分足够）

**验证备份可用**（第 3 步之后）：

```bash
npm run keystore:verify                 # 只打印地址 —— 必须与上面记下的 address 一致
```

**地址一致才算备份有效。** 完整做法与销毁-恢复演练见 **§5.5**。

---

### 阶段 5 · 接审批通道（**实盘的前提**）

```bash
# 1) @BotFather → /newbot → 拿 token
# 2) @userinfobot → 拿你的 user id
# 3) 先给新建的 bot 发一条消息（否则 bot 无权主动找你）
# 4) 取 chat id：
curl -s "https://api.telegram.org/bot<token>/getUpdates" | python3 -m json.tool | head -40
```

`.env` 里填：

```bash
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat.id>
TELEGRAM_ALLOWED_USER_IDS=<from.id>      # 只有这里的人能批准
TELEGRAM_ENABLED=true
```

`config/strategy.yaml` 里：

```yaml
  telegram:
    enabled: true
```

**两处都要改。** 然后：

```bash
npm run telegram:check
```

**期望**：`token: set`、`notifier: TelegramNotifier`、结论说通道可达。
若仍显示 `noopNotifier` → 说明变量名/开关写错了；**配好之前建仓不可能执行**。

---

### 阶段 6 · 小额实盘

```bash
# 1) config/strategy.yaml: initial_strategy_capital_usd ← 第一笔真实金额
# 2) .env: DRY_RUN=0
npm run dev
```

**流程**：启动 → 扫描 → 找到合格池 → **Telegram 弹出带 Approve/Reject 的确认请求**
（含金额、区间、ticks、滑点、价格影响）→ **你核对后点 Approve** → 才真正发交易。

判读标准见 §6.1 与 §8。**拿不准就 Reject 或让它超时** —— 超时只是"这轮不建仓"。

---

### 一张表：每阶段要什么、花不花钱

| 阶段 | 需要私钥 | 花钱 | 需要 TG | 能做 | 卡住的典型原因 |
|---|---|---|---|---|---|
| 0 Node 检查 | — | — | — | 确认环境 | `node_use_amaro=false` |
| 1 安装自检 | — | — | — | 验证仓库完整 | 依赖没装 |
| 2 建配置 | — | — | — | 自检配置 | `initial_strategy_capital_usd` 没改 |
| 3 只读验证 | — | — | — | 看市场、建仓预演 | RPC 不通 / 数据源限流 |
| 4 创建钱包 | 生成时不需要 | — | — | 生成/导入 keystore、备份 | **`KEYSTORE_PATH` 设了但文件不在** |
| 5 接 TG | ✅ | — | — | 开启确认门 | 忘了给 bot 发消息 / 两处开关没改 |
| 6 小额实盘 | ✅ | ✅ | ✅ | 真正建仓 | 白名单为空 / 池不合格 / 超过比例 |

### 常见卡点速查

| 报错 / 现象 | 原因 | 修法 |
|---|---|---|
| `ERR_NO_TYPESCRIPT` | Node 构建无 TS 支持 | 阶段 0 |
| `cannot read keystore file ... ENOENT` | 设了 `KEYSTORE_PATH` 但文件不存在 | `npm run keystore:generate`（或 `init`），或注释掉该变量退回只读 |
| `keystore: not configured` | 正常（未创建钱包） | 无 —— 阶段 4 才需要 |
| `telegram: DISABLED` | 未配通道 | 阶段 5 |
| 建仓一直不发生 | 大多是 TG 未配 | `npm run telegram:check` |
| 启动即 `STARTUP ABORTED` | 配置非法 | 看紧随其后的错误信息 |

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
npm run keystore:generate    # 新建钱包，只需输入口令
npm run keystore:init        # 导入已有私钥
npm run keystore:verify      # 验证备份可用（只打印地址）
npm run keystore:verify -- --export   # 导出私钥做备份（敏感）

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

**Q：`SMOKE READ FAILED (all RPC endpoints unreachable)` / `An internal error was received`？**
RPC 端点有问题。**先把 `.env` 里的 `BSC_RPC_URL` 留空** —— 程序会用已验证的公共端点。若你用的是 Infura：**它不支持 BNB Chain 的完整 JSON-RPC**（`eth_gasPrice` 会报 internal error）。换 Alchemy / Ankr / NodeReal 或自建节点。

**Q：报错里出现了我的 API key？**
已修：错误文本现在会把 URL 脱敏为 `https://host/v3/<redacted>`（保留 host 便于排查）。但**若你曾把这类输出贴给别人，请去 provider 控制台 rotate 该 key**。

**Q：启动报 `cannot read keystore file ... ENOENT`？**
`.env` 里设了 `KEYSTORE_PATH=secrets/wallet.enc`，但文件还没创建。两种修法：**创建它**（`npm run keystore:init`），或**注释掉那一行**退回只读模式。这是 fail-closed 设计，不是故障。

**Q：启动显示 `keystore: not configured` 正常吗？**
正常。表示当前是**只读模式**（能监控/扫描/告警，不能建仓）。没创建钱包之前就应该长这样。

**Q：从零到实盘该按什么顺序？**
见 `docs/OPS.md` **§7 可执行顺序**（6 个阶段，每步带期望输出）。关键点：**先配置、再只读验证、最后才初始化钱包**，前三阶段完全免费。

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

## 9. 创建钱包与私钥备份（**最重要的维护动作**）

**还没有钱包 → 让程序生成，你只输口令：**

```bash
npm run keystore:generate
```

私钥由 `node:crypto` 的 CSPRNG 在**本机生成、无网络、全程不显示**；你只需要设一个口令（≥12 字符）。
成功后打印 `address` —— **那就是你要转钱的地址**。

**已有私钥（如硬件钱包导出）→ 导入：**

```bash
npm run keystore:init
```

> ⚠️ **生成方式的代价**：私钥唯一的副本就在 `wallet.enc` 里，口令忘了就永久丢失。
> **生成完必须立刻备份**（就是下面这段）。


一句话：**只备份 `secrets/wallet.enc` 是不够的** —— 口令不在任何文件里，口令一忘文件就是废纸。所以要额外抄下私钥本身。（用 `keystore:generate` 生成的钱包尤其要：它的私钥除了这个文件之外**没有任何副本**。）

```bash
npm run keystore:verify -- --export    # 输入口令 → 手打 EXPORT 确认 → 打印私钥
```

拿到私钥后：

1. **抄到纸上两份**，放**两个不同的物理位置**
2. **或存密码管理器**（确保有云端备份）
3. **清屏**，确认没在录屏/投屏
4. **然后立刻验证备份可用**：

```bash
npm run keystore:verify               # 不打印私钥，只打印地址
```

打印出的 **address 必须和你创建时记录的一致** —— 一致才算备份有效。

**恢复**（三种场景，详见 `docs/OPS.md` §5.5）：

| 情况 | 怎么做 |
|---|---|
| 文件被误删 | 把备份的 `wallet.enc` 放回 `secrets/` → `npm run keystore:verify` |
| 换新机器 | 按 `OPS.md` §2 部署 → 放回 `wallet.enc` 与 `.env` → verify |
| **只有私钥，没有文件** | `npm run keystore:init` 重新输入私钥 → **地址不变**，资金仓位都不用动 |

`keystore:verify` 会区分"口令错""chain id 不对""文件损坏""文件被手改"，并给出不同建议 —— 恢复时按它的提示走，**不要**手工去编辑 `wallet.enc`。

**建议在真正放钱之前，用一个小额钱包把"备份→销毁→恢复"完整演练一遍。** 没验证过的备份不算备份。

---

## 10. 交给别人或换机器

需要带走的（可恢复运行的最小集合）：

1. **代码**（git 仓库）
2. **`config/` 三个 YAML**（策略参数 + 白名单）
3. **`.env`**（凭据与开关）—— 敏感，离线传递
4. **`secrets/wallet.enc`** —— 加密私钥（见 §9）
5. **口令（passphrase）** —— 不在任何文件里；**与 `wallet.enc` 分开保管**
6. **私钥本身**（`keystore:verify --export` 抄下来的）—— 口令丢了时唯一的退路
7. `data/lptrader.db` —— 可选；带上可保留仓位与决策历史

**4 和 5 不要放在同一个地方，6 不要和它们放在一起。** 三者全丢 = 资产永久丢失。

**不要**把 `.env`、`wallet.enc`、口令放进 git、聊天工具或工单。

新机器上的安装步骤见 `OPS.md` §2。

---

## 11. 速查卡

```bash
# 看状态
npm run dev                          # 配置/白名单自检
npm run telegram:check               # 审批通道是否可用

# 私钥
npm run keystore:generate            # 新建钱包（只需输入口令）
npm run keystore:init                # 导入已有私钥
npm run keystore:verify              # ★ 验证备份可用（只打印地址）
npm run keystore:verify -- --export  # 导出私钥做备份（敏感）

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
