# lptrader 使用手册

**适用范围**：系统已经装好、跑起来之后，**日常怎么看、怎么确认、怎么加资金、怎么停**。
**面向读者**：策略的操作者（你）。
**想装到新机器**：读 `OPS.md`；只想读一份 → `OPS-AND-USAGE.md`。
**所有命令都在仓库根目录执行。**

---

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

## 9. 私钥备份（**最重要的维护动作**）

一句话：**只备份 `secrets/wallet.enc` 是不够的** —— 口令不在任何文件里，口令一忘文件就是废纸。所以要额外抄下私钥本身。

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
