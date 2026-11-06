# dsh-backup-all · 跨平台快照与恢复策略（v1.2.0 契约）

> 本文是 v1.2.0 的实现契约：Host、提示词、UI 三端按此对齐。
> 目标：Linux / Windows 上都能创建快照；恢复时模型依据「快照记录的 OS」与「当前 OS」自动选策略；
> 支持 Linux→Linux、Windows→Windows、Linux→Windows 三种组合。

## 1. 系统类型与文件名

- `osType` 取值：`linux` / `windows` / `other`（`other` 仅作兜底，不作为正式支持场景）。
- 检测：`detectOsType(platform)`（`process.platform`：`linux`→linux，`win32`→windows，其余→other）。
- 快照文件名：`{年}-{月}-{日} {时}-{分}-{秒}-{osType}.backup.tar.br`
  - 例：`2026-11-06 10-30-00-linux.backup.tar.br`
  - 仍放在插件目录 `./backup/`；导入的旧文件保留原文件名（清洗后），不强制改名。
- 记录字段（records.json）：`osType`（linux/windows/other/**unknown**）；`imported`（true 表示引入）；
  旧记录无 `osType` 时视为 `unknown`，UI 显示灰色「旧版」，可删除，不做自动迁移。

## 2. manifest 新增字段

`manifest.json`：
```json
{
  "environment": {
    "dshHome": "...", "profileDir": "...", "profileName": "web", "homeDir": "...", "workspaces": [],
    "platform": "linux|win32|...", "osType": "linux|windows|other",
    "arch": "x64", "osRelease": "5.15.0-...", "dshVersion": "0.2.1-rc.5|null",
    "nodeVersion": "v24.x"
  },
  "snapshot": { "name": "...", "description": "...", "createdAt": "..." },
  "entries": [], "plugins": [], "snapshotPolicy": {}
}
```
- `environment.osType` 是恢复策略选择的唯一权威字段；`platform` 保留原始值便于排查。
- 快照 AI 的 user prompt 会注入 `currentEnvironment.osType` 等摘要。

## 3. 恢复策略矩阵（由模型选择，Host 计算 `compatibility` 辅助）

`restore_compare` 返回值新增：
```json
{"compatibility": {
  "snapshotOs": "linux", "currentOs": "windows",
  "mode": "same-linux|same-windows|linux-to-windows|windows-to-linux|unknown",
  "supported": true|false,
  "strategy": "full|full-windows|compat-linux-to-windows|compat-windows-to-linux|blocked",
  "restrictions": ["skip-plugin-code","skip-symlinks","reinstall-registry-only"],
  "notes": ["跨 OS：Linux 插件代码/原生模块不可直接用于 Windows；注册表插件按来源重装"]
}}
```
| 快照 OS → 当前 OS | strategy | 行为 |
|---|---|---|
| linux → linux | `full` | 完整恢复（配置/凭据/插件代码/数据/依赖；symlink 正常） |
| windows → windows | `full-windows` | 完整恢复；junction/symlink 创建失败时降级复制；ACL 提示替代 0600；命令用 PowerShell/cmd |
| linux → windows | `compat-linux-to-windows` | **兼容恢复**：配置/数据/凭据写回并重映射；`skip-plugin-code`（本地插件代码不写回，标记需在 Windows 迁移源码/重装）；`skip-symlinks`；registry 插件按来源重装；外部绝对路径 fallback；摘要明确列出未恢复项 |
| windows → linux | `compat-windows-to-linux` | **兼容恢复**（与 linux→windows 对称）：配置/凭据/外部数据写回并重映射；`skip-plugin-code`（Windows 插件代码/原生二进制不写回）；`skip-symlinks`（解包后移除符号链接/junction）；registry 插件按来源重装；Windows 盘符绝对路径 fallback 到 `<DSH_HOME>/restore-external`；profile 里 Windows `link:/file:` 绝对依赖移除；摘要列出未恢复项 |
| unknown → 任意 | `compat-linux-to-windows`（保守兼容） | 同跨 OS 兼容策略 |

- Host 在 `restore_apply_files` 内按 compatibility 强制执行 `restrictions`（AI 不遵守也不会写坏跨 OS 内容）：
  - `skip-plugin-code`：`kind: 'plugin-code'` 条目跳过并记 warning；
  - `skip-symlinks`：解包阶段的符号链接条目跳过（记录 warning）；
  - `blocked`：保留策略（当前矩阵不再产生）；apply 返回 ok:false + 明确原因。
- 恢复提示词必须写清上述矩阵与每类策略的逐步操作；AI 先调 `restore_compare`，再按 `compatibility.strategy` 执行，不自造策略。

### 3.1 可选增强：跨 OS 迁移纯 JS 插件代码（v1.3.0）

默认跨 OS 恢复 `skip-plugin-code`（插件代码不写回）。用户可在「高级设置 → 快照策略 → 跨 OS 恢复插件代码」选择 **尝试迁移纯 JS 插件代码（实验性）**，对应设置：

```json
{ "snapshot": { "crossOsPluginCode": "skip" } }   // "skip"（默认）| "js"
```

- 设为 `js` 时，`buildCompatibility` 的 `restrictions` 用 `plugin-code-js-only` 代替 `skip-plugin-code`（仍保留 `skip-symlinks` / `reinstall-registry-only`），并在 `notes` 说明。
- Host 在 `restore_apply_files` 内对每个 `kind:"plugin-code"` 条目做**纯 JS 分类**（`lib/plugin-code.js`）：
  - 允许：`.js/.mjs/.cjs/.json/.md/.css/.html/.svg/.png/.woff2/.yml/.sh` 等文本/通用资源；
  - 拒绝：`.node/.dll/.so/.dylib/.exe/.msi/.lib/.bat/.cmd/.ps1` 等原生或 Windows 专有文件；未知扩展；符号链接；`package.json` 的 `os` 不含目标系统、`cpu` 不含目标架构、`gypfile:true`；无 JS 入口；文件数 >3000 或体积 >64MB；
  - 通过才写回；不通过 → 跳过 + `warnings`，摘要逐项列出。
- 前提：快照必须真的打包了插件代码（`packPluginCode` 为 `local-only`/`all`；`none` 时无代码可迁）。
- 局限：即使通过分类，插件仍可能依赖系统命令/服务/注册表等；跨 OS 迁移后需在目标机实测重启。原生插件仍必须重装/重编译。

## 4. 导入 / 导出 API

### 4.1 导入
`POST /dsh-backup-all/snapshot/import`
- Headers（UTF-8 percent-encoded）：
  - `x-snapshot-filename`：原始文件名（如 `2026-11-06 10-30-00-linux.backup.tar.br`）
  - `x-snapshot-name`：展示名（用户可改；缺省 = 文件名去掉 `.backup.tar.br`）
  - `x-snapshot-description`：描述（可空）
- Body：归档原始字节（`application/octet-stream`）；Host 流式落盘到 `backup/` 临时文件，限制 **512 MiB**。
- 校验：brotli + tar 可读、`manifest.json` 存在且可解析；`osType` 取 `manifest.environment.osType` → 文件名 token → `unknown`。
- 成功：文件保留原名（清洗 Windows 非法字符/保留名，重名加 `-1`），记录 `{kind:'snapshot', imported:true, osType, name, description, bytes}`，返回 `{ok:true, record}`。
- 失败返回 HTTP 200 JSON `{ok:false,error}`（前端只看 ok）。

### 4.2 导出
`GET /dsh-backup-all/snapshot/export?id=<recordId>`（同源 cookie 鉴权）
- 200：`content-type: application/octet-stream`、`content-disposition: attachment; filename*=UTF-8''<encoded>`、`content-length`，流式返回。
- 404/400：JSON `{ok:false,error}`。

## 5. 记录/UI 契约

- `getState()` 的 records/archived 每条包含：`id,name,description,file,bytes,sizeText,createdAt,archived,kind,osType,imported`。
- UI：
  - 工具条新增「引入快照」按钮：文件选择（accept `.backup.tar.br,.tar.br`）→ 展示文件名 + 名称输入（默认去掉 `.backup.tar.br`/`.tar.br` 后缀）+ 描述 → 上传进度/错误 → 成功后刷新。
  - 每张卡片新增「导出」按钮：fetch 导出接口 → Blob → 触发下载（手机 WebView 用 <a download>；失败 toast）。导出成功/失败都有反馈。
  - 每张卡片显示 OS 徽章：`Windows` 蓝底、`Linux` 橙底、`unknown/旧版` 灰底；与名称同行。
- 旧快照（无 osType）只显示「旧版」并保留删除，不自动迁移。

## 6. Windows 平台适配要求（Host）

1. 命令执行：用 `lib/platform.js` 的 `runCommand()`（Windows 走 `cmd.exe /d /s /c` 解析 `dsh.cmd`/`pnpm.cmd`）；禁止直接 `execFile('dsh')`。
2. 路径：`pathCompareKey()` 做 Windows 大小写不敏感比较；`isInside`/前缀重映射使用它；盘符/分隔符归一。
3. 符号链接：解包时 Windows 创建 symlink 可能 EPERM；`extractArchive` 增加 symlink 策略（`auto|copy|skip`），记录 warnings；跨 OS 强制 `skip`，Windows→Windows 默认 `auto`（失败降级复制/跳过）。
4. 权限：`permissionModeSupported()` 为 false 时不写 0600 也不报错；RESTORE.md 用 ACL 说明。
5. 文件名：导入文件名用 `sanitizeFileStem()`（非法字符、保留名、尾点空格）。
6. RESTORE.md：命令同时给 Linux 与 Windows(PowerShell) 两种版本；跨 OS 场景显著标注不可恢复项。

## 7. 提示词要求（泛型，不点名具体插件/Skill/MCP）

- 快照系统提示词：通用目标 → 工具 → **按当前 osType 的打包策略**（Linux：权限/符号链接/隐藏文件/`$DSH_*` 占位符；Windows：盘符/USERPROFILE/APPDATA/junction/ACL/`dsh.cmd`/PowerShell 命令；两者都不写具体插件名）→ 外部文件判定 → 安全/凭据 → 自检。
- 恢复系统提示词：通用目标 → 工具 → **先 compare 拿 compatibility** → 按 matrix 选策略 → 各策略分步（full、full-windows、compat-linux-to-windows、compat-windows-to-linux、blocked）→ 失败处理/摘要/自检。
- 保持工具名与顺序不变（快照 11 个、恢复 7 个）；不要把任何具体插件名、路径、示例写死进提示词。
- 泛型约定（v1.1.0 提示词实现说明，不改本节字段/行为）：
  - 两份提示词提到自身一律用泛称「本插件」，不出现任何具体插件/Skill/MCP 包名、模型名或写死的机器路径；示例路径一律用占位符（`$DSH_HOME/...`、`$DSH_PROFILE_DIR/...`、`<profileName>` 等），具体名称以工具返回为准。
  - 快照提示词以用户提示词注入的 `osType`（缺失时按 `platform` 推断）选择打包策略；恢复提示词的 strategy/restrictions 关键词与 §3 `compatibility` 枚举逐字一致（`full` / `full-windows` / `compat-linux-to-windows` / `compat-windows-to-linux` / `blocked`；`skip-plugin-code` / `skip-symlinks` / `reinstall-registry-only`），并写明 `compatibility` 缺失/unknown 时的处理（先 `restore_compare`，仍无法判断则保守按 `compat-linux-to-windows`）。
  - 两份提示词文末保留「版本与预算说明」（适用版本、工具数、时长/调用预算）。

## 8. 测试/验收

- 单元：platform 检测/文件名/sanitize/命令引用；manifest osType；records 迁移/导入导出路由（mock req/res）；compatibility 矩阵；archive symlink 策略；RESTORE.md 双平台命令；提示词不含具体名字且含矩阵关键词。
- e2e：Linux 生成快照（文件名 `-linux`）、导出→删除→导入→恢复；跨 OS 用 fake env（osType 覆盖）跑 compat 策略并断言 plugin-code/symlink 被跳过。
- 真机：Linux DSH + Windows DSH（win→win、linux→win），UI 截图（引入/导出/徽章/下拉/移动端）。
