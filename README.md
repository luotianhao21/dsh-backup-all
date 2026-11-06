# dsh-backup-all

> **快照一切，给自己留一份完整备份。**
> 把整个 DSH 环境——插件、Skill、MCP、Agent Preset、配置、凭据、外部数据——打包成一个可回滚的快照文件。升级前、换机器前、重装系统前，点一下就好。

**简体中文** | [English](README.en.md)

[![Version](https://img.shields.io/badge/version-1.3.0-blue.svg)](CHANGELOG.md)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-6f42c1.svg)](https://github.com/deepseek-ai)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-339933.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## 这是什么

DSH 用久了，环境会散落在很多地方：profile 配置、`node_modules` 里的插件、`dshbox-plugins` 本地插件、Skill、MCP 连接、Agent Preset、`.credentials.yaml`、外部工作目录……手工备份几乎不可能完整。

**dsh-backup-all 的初衷很简单：快照一切，给自己做备份。**

- 它**不是**一个只服务"迁移"的工具，而是你的**环境后悔药**：在动任何东西之前，先存一份完整现场；
- 创建快照时，Host 自动收集固定配置、凭据、Skill 等，AI 负责发现"插件之外、但运行时确实被引用"的外部数据，并写下恢复计划和 `RESTORE.md`；
- 需要回滚时，AI 先比对差异，再分批写回（写前有安全备份），最后重装依赖；
- 也支持换机器/换系统时带着快照走（跨 OS 兼容恢复是**附加能力**，不是这个插件的主线）。

## 你会用它做什么

| 场景 | 用法 |
|---|---|
| 升级 DSH / 大改插件前 | 先创建一条快照，出问题一条命令回滚 |
| 误删了配置 / Skill / 本地插件 | 从快照恢复，回到删除前的完整现场 |
| 准备重装系统 / 换电脑 | 创建快照，把 `.backup.tar.br` 拷走，到新机器上恢复 |
| 想给环境留一个"保险存档" | 定期创建快照；快照就是自包含的压缩包，可离线保管 |
| 只是想看看环境里到底有什么 | 快照里的 `INVENTORY.md` / `RESTORE.md` / `manifest.json` 是完整清单与恢复说明 |

## 它备份什么

- **profile 配置**：`package.json`、`cordis.yml`、`cordis.patch.yml`、`pnpm-lock.yaml` 等；
- **插件**：registry 插件记录来源（恢复时重装）；本地 `file:`/`link:` 来源、无法再下载的插件代码可一并入包；
- **Skill / Agent Preset**：扫描到的条目与配置；
- **MCP 连接**：连接定义与相关配置；
- **凭据**：`.credentials.yaml`（可在策略里选择不打包）；
- **外部数据**：AI 结合环境清单与运行时引用，发现并纳入那些"插件之外、但恢复后确实还需要"的目录/脚本（按安全规则校验）。

> 默认打包策略是「仅打包本地不可再下载插件」：能重新下载的 registry 插件只记来源，恢复时重装；本地插件代码才真正入包，避免快照无谓变大。

## 怎么工作

**创建快照**：Host 扫描环境（插件 / Skill / MCP / Preset / 配置 / 凭据）→ AI 判断哪些外部数据值得入包 → 生成恢复计划与 `RESTORE.md` → 打包成 tar + Brotli 高压缩归档（通常只有原体积的 10% 左右）。全程有进度、可中断。

**恢复（回滚）**：先为当前环境自动创建「恢复前快照」→ AI 对比快照与当前环境的差异 → 分批写回（每个被覆盖文件先做安全备份）→ 重装依赖 → 重启 DSH 生效。恢复前快照意味着：**回滚本身也可以再回滚**。

## 功能一览

- 高压缩快照（tar + Brotli quality 11），自带 `manifest.json` / `INVENTORY.md` / `RESTORE.md`；
- AI 驱动：快照与恢复使用一个可独立配置的模型（OpenAI 兼容 / Anthropic），工具调用可见、可中断；
- 双重安全网：恢复前快照 + 逐文件安全备份；
- 设置页「Backup ALL」：快照列表 / 已归档 / 高级设置；后台悬浮进度球；移动端适配；
- 每张卡片可**导出**；任何 `.backup.tar.br` 都可通过「引入快照」导入；
- 快照文件名带系统类型（`...-linux.backup.tar.br` / `...-windows.backup.tar.br`），恢复时按快照与当前系统自动选择策略；
- **附加能力：跨操作系统兼容恢复**。Linux ↔ Windows 换机器时，配置/数据/凭据可以迁移，插件代码按策略处理（默认跳过；可选实验性的纯 JS 插件代码迁移）。原生插件/系统相关内容需要在目标系统重建。

<table>
<tr>
<td><img src="docs/screenshots/vm-win-01-list.png" alt="快照列表与系统徽章" width="100%"></td>
<td><img src="docs/screenshots/vm-linux-10-import-dialog.png" alt="引入快照弹窗" width="100%"></td>
</tr>
<tr>
<td align="center">快照列表 · 系统徽章 · 每卡导出</td>
<td align="center">引入快照 · 默认名称自动去后缀</td>
</tr>
</table>

## 安装

前置：DSH `0.2.1-rc.5`（或兼容版本）、Node.js >= 22、pnpm（DSH 插件管理自带）。

```bash
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:luotianhao21/dsh-backup-all

# npm 发布后（见 npm 包页）
dsh plugin --profile web add dsh-backup-all
```

重启 DSH；打开 **设置 → 插件** 确认 `dsh-backup-all` 已启用，设置侧栏会出现 **Backup ALL**。

从本地源码安装：

```bash
git clone https://github.com/luotianhao21/dsh-backup-all.git
cd dsh-backup-all
dsh plugin --profile web add link:"$PWD"
```

## 快速开始（备份 → 回滚）

1. **设置 → Backup ALL → 高级设置**：填 AI 模型（Base URL / API Key / Model ID），点「测试模型接通性」；
2. （可选）「快照策略」：插件代码打包范围、是否不打包凭据；
3. 回到「快照」页，点 **创建新快照**，两步确认后等待完成——这就是你的环境存档；
4. 需要回滚时，在快照卡片点 **恢复**；恢复前会自动创建「恢复前快照」；
5. 想离线保管：点卡片 **导出**，把 `.backup.tar.br` 存到你自己的安全位置；换机器时用 **引入快照** 导回来。

### 快照策略

| 设置 | 默认 | 说明 |
|---|---|---|
| 插件代码本体 | 仅打包本地不可再下载插件 | `local-only` / `all` / `none` |
| 不打包凭据 | 关 | 开启后 `.credentials.yaml` 不入包，恢复后需重填 |
| 跨 OS 恢复插件代码 | 跳过 | `skip` / `js`（仅跨 OS 时生效，实验性纯 JS 插件迁移） |

### 恢复策略（按快照 OS → 当前 OS 自动选择）

| 快照 OS → 当前 OS | 策略 | 行为 |
|---|---|---|
| 同系统 | 完整恢复 | 全部条目 + 依赖重装（最常用：回滚自己的快照） |
| 跨系统 | 兼容恢复 | 配置/数据/凭据迁移；插件代码默认跳过；符号链接跳过；registry 插件重装；外部路径 fallback |

> 跨 OS 是**兼容恢复**，不是逐字节镜像；原生插件/系统服务/注册表相关内容需要在目标系统重建。同系统恢复才是这个插件设计上的主路径。

## 安全说明

- 快照可能包含 `.credentials.yaml` **明文凭据**（可在策略里关闭），请把快照文件当作敏感数据保管；
- 恢复写回前会做安全备份，恢复前还会自动创建「恢复前快照」；
- AI 请求只包含环境摘要与必要条目信息，Host 不会把凭据明文放进 prompt；
- 建议恢复/迁移后轮换 API Key 等凭据。

## 目录结构

```
dsh-backup-all/
├── index.js            # Host 插件入口（路由 / 工具 / UI 槽）
├── client.js           # Web 客户端（设置页 / 悬浮球 / 弹窗，纯 JS 无构建）
├── cordis.patch.yml    # DSH bundle patch
├── lib/                # Host 逻辑（archive / runner / tools / prompts / 平台适配）
├── prompts/            # 泛型 AI 系统提示词
├── locale/             # 中英文文案
├── test/               # Node 原生测试（81 项）
└── docs/               # API 契约 / 平台策略 / UI 规格
```

## 开发与测试

```bash
node --check client.js
for f in lib/*.js; do node --check "$f"; done
node --test test/*.test.mjs     # 81 tests
```

## 文档

- [API 契约](docs/API-CONTRACT.md)
- [平台与恢复策略](docs/PLATFORM-STRATEGIES.md)
- [UI 规格](docs/UI-SPEC.md)
- [更新日志](CHANGELOG.md)

## License

[MIT](LICENSE) © 2026 luotianhao21

> 个人开发维护，与 DeepSeek 官方无隶属关系；快照含环境信息，请自行评估保管与凭据安全。
