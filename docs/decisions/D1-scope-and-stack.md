# D1 — 首期范围、技术栈与密钥方案

**日期**：2026-09-29
**状态**：用户已确认（Onboarding 问卷）

## 决策

| # | 决策项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 风险面 | 链上资金 / 签名交易；密钥以启动口令派生密钥加密存储 | 用户作答 |
| 2 | 技术栈 | TypeScript / Node（viem + Uniswap/Pancake V3 SDK 生态） | 用户作答；与基线 §81–§84 的 TS 接口定义一致 |
| 3 | 首期范围 | **直接 Phase 3 起**：单池实盘 QQQB / USDC | 用户作答（偏离基线 §109 的 Phase 1→2→3 推荐顺序）。**执行授权与确认闸门见 `D2-execution-and-approvals.md`**（后续补充：Mode 1 直接实盘 + Telegram 确认门）。 |
| 4 | Plan 确认节奏 | 技术执行一轮无异议即确认；产品/规则/范围变更显式确认 | 用户作答（skill 默认） |
| 5 | 密钥方案 | 启动时输入 passphrase，私钥 AES 加密落盘；私钥生成加密用该 key | 用户作答 |
| 6 | 编号 / 归档 | `D<序号>`；`docs/archive/tasks/<date>-D<n>/` | onboarding 默认 |

## 密钥方案细化（技术执行细节，非产品语义）

- 算法：**AES-256-GCM**（认证加密，防篡改）。用户原话为 "AES/DES"；**DES 已废弃**（56-bit 密钥、CBC 无认证），一律用 AES-256-GCM，不提供 DES 路径。
- 密钥派生：passphrase → `scrypt`（`node:crypto`，N=2^17, r=8, p=1）→ 32-byte key；每份密文独立随机 salt(16B) + nonce/IV(12B) + authTag(16B)。
- 存储：密文文件（`secrets/wallet.enc` 或 DB 列），权限 `0600`，gitignore。passphrase 不落盘。
- 进程内：解密后仅驻内存，禁止写日志；退出即清引用。
- 环境：禁止把 passphrase 或私钥放进 env 以外的地方（env 仅作 CI/测试的次级手段，实盘仍推荐交互输入或 KMS）。

## 后果

- 遵循基线 §109 顺序会先跑 Paper Trading 以降低风险；用户选择直接进入 Phase 3，因此**风险补偿措施**写入 `AGENTS.md`：主网真实资金操作需显式确认、白名单为空拒绝建仓、所有写操作先 testnet/dry-run。
- 基线 §101/§102（Backtest / Paper Trading）在 Iteration 1 之外，作为独立迭代待立项。

## 未决

- 参考 NAV 数据源、池历史数据源、股票代币官方合约地址：Onboarding 调研中，结论将回填本文件与 `docs/known-issues.md`。
