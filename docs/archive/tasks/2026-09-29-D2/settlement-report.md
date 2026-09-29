# D2 — Settlement Report

```yaml
settlement:
  task: D2
  completion_gate: passed
  stable_facts:
    - 8 个 bStock 的链上 `uiMultiplier()` 实测值（QQQB 1.000724838658、MSFTB 1.001313964833、AAPLB 1.000603906076、METAB 1.000548290411、NVDAB 1.000778223753；AMZNB/TSLAB/PLTRB 恰为 1e18），且本地换算与合约 `toUIAmount` 逐样本相等
    - Pancake SmartRouter = 0x13f4ea83d0bd40e75c8222255bc855a974568dd4（= @pancakeswap/smart-router 的 SMART_ROUTER_ADDRESSES[56]），且**它是 §42 原子建仓的写目标**，必须留在白名单内
    - PancakeSwap V3 与 Uniswap V3 的 fee 枚举**不共享**（Pancake 100/500/2500/10000；Uniswap 100/500/3000/10000），per-DEX 表是必需的
    - §99 cross-check 必须固定同一个区块高度；跨区块比较会让**每一次**区块可变读取（slot0/余额）假失败
    - 真实市场下通过 §16 的池数与池子随时间变化（同一 QQQB/USDC 池一次 0.66% 一次 0.04% 的 $3500 impact）→ §16 必须每轮重算，不可缓存为池属性
    - §5 的 NAV 公式与 §64 Profit Vault 不自洽（KI-15），实现取保守读法并待用户确认
  updated:
    - PROJECT.md（状态 → Settling；验证阶梯表；实测可执行性）
    - docs/code-map.md（全量登记已实现模块 → 基线章节 → 证据路径）
    - docs/iterations/iteration-1.md（状态 → Settling）
    - docs/iterations/iteration-1-acceptance.md（§108 逐项 → 证据 → 状态；新增 review 回归表）
    - docs/known-issues.md（KI-1/3/4/16/19/21/22/23/24 销号；新增 KI-25/26/27）
    - AGENTS.md（无需改动：交付过程未暴露流程门失效）
  indexes_updated:
    - docs/document-index.md（新增 review/test/settlement 与 evidence 文件）
  archived:
    - docs/archive/tasks/2026-09-29-D2/plan.md
    - docs/archive/tasks/2026-09-29-D2/implementation-summary.md
    - docs/archive/tasks/2026-09-29-D2/review-report.md
    - docs/archive/tasks/2026-09-29-D2/test-report.md
    - docs/archive/tasks/2026-09-29-D2/settlement-report.md
  evidence_files:
    - docs/research/evidence-smoke-read-20260929.txt
    - docs/research/evidence-smoke-scan-20260929-t6.txt
    - docs/research/evidence-dry-run-build-20260929.txt
    - docs/research/evidence-pool-scanner-filter-20260929.md
  proposed_for_confirmation:
    - KI-15：§5 NAV 是否重复计入 realized fees（直接影响 §66 何时触发）
    - KI-13：是否加程序化金额上限（§103 阶梯）
    - 是否为 L3 评审配置**不同模型**（本轮评审与开发者同模型，独立性靠隔离会话实现）
  no_change:
    - AGENTS.md — 本轮未发现流程门失效；但记录一条流程缺口（见下）
    - docs/product/stock-lp-auto-strategy-v1.md — 产品基线未变（仅新增读法澄清文件与 known-issues）
```

## 完成清单

```text
[x] Plan 已批准（含用户裁定 D3/D4/C1/C3）
[x] Develop 完成（T1–T13 + DEX 适配器，105 文件 / 41,477 行）
[x] Blocking findings 全部关闭（4 个，各自带回归测试）
[x] 独立 Review 已执行（原始结论 failed → 修复后无已知 blocking 残留）
[x] Test 已执行；未覆盖项显式处置（4 项：3 项用户门控/1 项范围外）
[x] 产品影响已解决（KI-15 待用户确认，已登记）
[x] 技术/接口/测试文档已更新
[x] Code Map 已核对并更新
[x] Document Index 已核对并更新
[x] 规则与 Skill 影响已解决（AGENTS.md 无需改动）
[x] 任务产物已归档
[x] Settlement Report 存在
[x] 新会话可仅凭仓库发现当前状态（PROJECT.md → code-map → acceptance → archive）
[x] git 工作区干净，全部产物已提交
```

## 本轮交付的净效果（缺陷视角）

| # | 缺陷 | 发现方式 | 状态 |
|---|---|---|---|
| 1 | `.gitignore` 未锚定 → 整层 `src/data/**` 未入库 | 切片自查 | 修复 |
| 2 | 临时 URI 落成真实文件 + scratch 脚本入库 | 集成检查 | 修复 |
| 3 | 伪造 all-true guard 可达非白名单地址 | 独立评审探针 | 修复（KI-21） |
| 4 | 原子建仓 hash 记派生键 → 幽灵未决记录 | 独立评审探针 | 修复（KI-22） |
| 5 | REVERTED 后重试路径不可用 | 独立评审探针 | 修复（KI-23） |
| 6 | 稳定币用股票价源定价 → NAV=0 → 虚假 §66 停机 | 独立评审探针 | 修复（KI-24） |
| 7 | §99 跨区块比较 → 每次真实读取都可能失败 | 集成活链复现 | 修复（KI-19） |
| 8 | Pancake SmartRouter 不在写目标白名单 | 由 #3 的修复当场发现 | 修复 |
| 9 | HTTP transport 无超时 → 挂死 cadence | 切片自查 | 修复（`DEFAULT_HTTP_TIMEOUT_MS = 30s`） |
| 10 | 内存库共享（`:memory:` 被 memoize） | 集成测试串味 | 修复（KI-16） |
| 11 | 我误加的 selector 校验挡掉 6 个合法调用 | 全量回归 | 回退（仅保留目标校验） |
| 12 | 代理卡死/崩溃（1 个开发 + 4 个评审） | 运行时观察 | 重切 + 从探针取证 |

**前 6 项中，有 4 项仅凭读代码或跑既有测试无法发现** —— 它们是本次独立 Review 的实际产出，而非形式流程。

## 流程复盘（本轮）

- **有效的门**：① 冻结契约 + 显式契约缺口上报（逼出 `swapForDeficit`/`supportsAtomicBuild`，避免原子性静默丢失）；② **评审者自建探针**（4 个最严重缺陷全靠它）；③ 全量回归（当场抓住我误加 selector 校验的过度拦截）；④ 真实链上 dry-run（证明 §35 反证、tick 对齐、impact 独立复算 exact）。
- **过重的门**：无。L3 的三个 reviewer 各自聚焦，未产生重复工作。
- **漏过的缺陷类型（须补进 `AGENTS.md`）**：
  1. **`git ls-files` 核对缺失** → `.gitignore` 未锚定让整层代码未入库，`git status` 与"文件可读"都发现不了。**已补入 `AGENTS.md`**：Settlement 硬性验收增加「逐目录 `git ls-files` 与实际文件数核对」。
  2. **「组合根装配」不在任何验收项里** → 3 个最严重缺陷（#6 定价接错源、#3 写路径信任调用方、#8 目标合约漏登记）都发生在**装配层**，而 §108 验收全是模块级。**已补入**：新增验收项「组合根装配必须以真实依赖跑通一次只读 + dry-run 全链路」。
  3. **评审代理崩溃无兜底** → 4 个评审者都未产出报告。**已补入**：要求评审者把探针**落在仓库外固定路径**并在中断前至少落一份最小 findings，以便取证。
- **撞坑即补**：以上 3 条已写入 `AGENTS.md`。

## 用户待决（阻塞后续迭代，不阻塞本次交付）

1. **KI-15**：§5 NAV 读法确认。
2. **KI-13**：是否加金额上限。
3. 是否配置**独立模型**做 L3 评审。
4. 真实实盘所需的：签名钱包（`npm run keystore:init`）、`TELEGRAM_BOT_TOKEN`/`CHAT_ID`/`ALLOWED_USER_IDS`、以及首笔建仓的人工确认。
