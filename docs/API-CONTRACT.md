# HTTP API 契约 — dsh-backup-all（Lead 定义，勿擅自改动字段名）

所有路由前缀 `/dsh-backup-all`，Host 用 `ctx.webServer.register({kind:'prefix', path:'/dsh-backup-all', handler})` 实现。
客户端同源 `fetch('/dsh-backup-all/...')`。全部返回 JSON；失败统一 `{ "ok": false, "error": "中文错误" }`，HTTP 4xx/5xx 均可。
写操作 body 为 JSON（`content-type: application/json`）。

## 1) GET /state —— 全量状态（UI 每 600ms 轮询）

```jsonc
{
  "ok": true,
  "version": "1.0.0",              // 标题里的版本号
  "totalBytes": 12345678,          // 所有快照文件（含已归档）占用总字节
  "backupDir": "/root/projects/DSH Backup ALL/backup",
  "records": [                     // 仅未归档；恢复前快照固定第一条，其余按 createdAt 倒序
    {
      "id": "uuid",
      "name": "2026-11-05 20-45-12",
      "description": "说明文字",
      "createdAt": "2026-11-05T12:45:12.000Z",
      "file": "2026-11-05 20-45-12.backup.tar.br",
      "bytes": 1234567,
      "archived": false,
      "kind": "snapshot",          // "snapshot" | "pre-restore"
      "label": ""                  // 预留给 UI，可空
    }
  ],
  "archived": [                    // 已归档记录（字段同 records）；UI 的「已归档」页面读这里
    { "id": "uuid", "name": "…", "description": "…", "createdAt": "ISO", "file": "…", "bytes": 0, "archived": true, "kind": "snapshot", "label": "" }
  ],
  "run": {                         // null = 当前没有运行/最近一次运行已清理
    "id": "run-uuid",
    "kind": "snapshot",            // "snapshot" | "restore"
    "status": "running",           // "running" | "done" | "interrupted" | "failed"
    "progress": 42,                // 0..100 整数
    "phase": "AI 正在分析外部文件",
    "message": "正在检查 ~/.dsh/xingxi",
    "snapshotName": "我的快照",     // 本次运行对应的快照名（恢复时为被恢复快照名）
    "targetRecordId": "uuid",      // kind=restore 时：要恢复的快照记录 id
    "startedAt": "ISO",
    "endedAt": null,
    "error": null,                 // 失败时中文原因
    "outputCursor": 37,            // 已有多少条输出行 → UI 传给 /log?since=
    "canAbort": true
  },
  "settings": {
    "snapshot": {                   // 快照策略（高级设置里的「快照策略」卡片）
      "packPluginCode": "local-only",   // local-only | all | none
      "excludeCredentials": false       // true = 不打包 .credentials.yaml（恢复后需重填）
    },
    "ai": {
      "baseURL": "https://…/v1",
      "protocol": "openai-completions",   // "openai-completions" | "anthropic-messages"
      "modelId": "deepseek-v4.1-flash-1017",
      "contextWindow": 1000000,           // 换算后的 token 数
      "maxOutput": 65536,
      "effort": "max",                    // "off"|"low"|"high"|"max"
      "hasApiKey": true,
      "apiKeyMasked": "sk-…abcd",
      "configured": true,                 // baseURL+modelId+apiKey 齐全
      "connected": true,                  // null=未测过
      "connectedAt": "ISO",
      "connectDetail": "HTTP 200"
    }
  }
}
```

客户端格式化字节单位（KB/MB/GB，自适应用 1024 进位，保留 1 位小数、去掉 `.0`）。

## 2) GET /log?since=N&runId=… —— 增量输出

```jsonc
{ "ok": true, "runId": "run-uuid", "cursor": 40,
  "lines": [ { "seq": 38, "kind": "assistant", "text": "…" },
             { "seq": 39, "kind": "tool", "text": "backup_set_progress …" },
             { "seq": 40, "kind": "system", "text": "开始打包" } ] }
```
- `kind`: `assistant`（AI 正文/思考摘要）| `tool`（工具调用/结果摘要）| `system`（Host 阶段提示）| `error`
- `since` 缺省 0；`runId` 不匹配时返回该 run 的全部（客户端重开窗口时用）。
- Host 端每 run 最多保留 500 行，超出丢最旧（seq 递增不变）。

## 3) POST /snapshot/create

body: `{ "name": "…", "description": "…" }` → `{ "ok": true, "runId": "run-uuid" }`
- 校验：name 非空（≤200 字符）；description ≤2000；不要求 AI 配置齐全？**要求**：未配置返回 `{ok:false,error:"请先在高级设置中配置 AI"}`。
- 立即返回；真正的工作在后台跑（UI 轮询 state/log）。
- 若已有 run 在跑：`{ok:false,error:"已有任务正在运行"}`。

## 4) POST /snapshot/abort  body: `{ "runId": "…" }` → `{ "ok": true }`
- 向 AI 发送中断指令（Host 内部常量 `INTERRUPT_INSTRUCTION`），中止请求，删除本次暂存目录/半成品包，run.status=`interrupted`。
- runId 不匹配或已结束：`{ok:false,error:"任务已结束"}`。

## 5) POST /snapshot/edit  body: `{ "id": "…", "name": "…", "description": "…" }` → `{ok:true}`

## 6) POST /snapshot/archive  body: `{ "id": "…", "archived": true }` → `{ok:true}`
（已归档页面里点「取消归档」传 `archived:false`；归档不删压缩包文件）

## 7) POST /snapshot/delete  body: `{ "id": "…" }` → `{ok:true}`
（只允许已归档记录 / pre-restore 记录删除；删除同时删压缩包文件）

## 8) POST /snapshot/promote  body: `{ "id": "…", "name": "…", "description": "…" }` → `{ok:true, record:{…}}`
（恢复前快照「保存为永久快照」：kind 改回 `snapshot`，改名/改描述；仍占第一位之外按时间排）

## 9) POST /restore/start  body: `{ "id": "…" }` → `{ok:true, runId}`
runner 自动：① 先创建「恢复前快照」（若已存在则先删除旧的 pre-restore 记录+文件）② 解包 ③ AI 恢复。
run.kind=`restore`，`targetRecordId`=被恢复记录。

## 10) POST /restore/abort  body: `{ "runId": "…" }` → `{ok:true}`

## 11) GET /settings → `{ok:true, settings:{ ai:<同 state.settings.ai>, snapshot:<同 state.settings.snapshot> }}`

## 12) POST /settings  body（未提供的字段保持不变；`apiKey` 传 `""`/缺省=不改，传 `null`=清除）
AI 配置字段：
```json
{ "baseURL":"…", "protocol":"openai-completions", "apiKey":"sk-…", "modelId":"…",
  "contextWindowValue": 1000000, "contextWindowUnit": "K"|"M",
  "maxOutputValue": 64, "maxOutputUnit": "K"|"M", "effort":"max" }
```
快照策略字段（可与 AI 字段一起发，也可只发 snapshot；两者分别合并，互不覆盖）：
```json
{ "snapshot": { "packPluginCode": "local-only" | "all" | "none", "excludeCredentials": false } }
```
→ `{ok:true, settings:{ ai:{…}, snapshot:{…} }}`
（UI 用 K/M 单位输入，Host 换算成实际 token 数存 `contextWindow/maxOutput`；state 只暴露换算后的值。）

## 13) POST /settings/test  body（同 /settings，可只传当前表单值，含 apiKey 明文；apiKey 缺省用已存值）
→ 成功 `{ok:true, connected:true, latencyMs:1234, detail:"HTTP 200", modelId:"…"}`
→ 失败 `{ok:false, connected:false, error:"中文原因", detail:"…"}`（同时更新 settings.ai.connected/connectedAt/connectDetail）

## 14) POST /clear  body: `{ "confirm": true }` → `{ok:true, removed: 3}`
（删除所有快照记录+压缩包文件，含已归档；保留设置）

## 15) GET /version → `{ok:true, version:"1.0.0"}`（可选）

## UI 轮询策略（client.js）

- 全局单例 store（模块级）：`subscribe(fn)`、`getState()`、`start()/stop()` 引用计数。
- 每 600ms `GET /state`；若 `state.run?.status === 'running'` 或存在未读输出，每 450ms `GET /log?since=cursor&runId=run.id` 并把新行追加到内存 log 数组（上限 500，客户端再截断显示）。
- 所有 POST 失败时把 `error` 作为 toast/内联提示展示；成功后立即手动刷新一次 state。
- UI 的进度条动画/中断回退动画是**纯客户端**表现：
  - 中断点击：立即把按钮态切到 `interrupting`，进度从当前值线性回退到 0（约 1.2s），完成后显示红色「中断快照成功」。
  - 完成：`run.status==='done'` → 按钮变淡绿「快照完成」，下方出现「关闭」按钮。
  - 失败：红色「快照失败」+ error 文案 + 下方「关闭」。


## 16) 恢复路径自动重映射与依赖安装（2026-11-05 第二轮新增）

- `manifest.environment` 记录快照机的 `dshHome/profileDir/homeDir`，`manifest.workspaces` 记录旧 workspace 列表；
  条目 target 有两种形态：占位符（`$DSH_HOME` / `$DSH_PROFILE_DIR` / `$WORKSPACE:<name>`）与外部绝对路径。
- 恢复 AI 的 `restore_compare` / `restore_apply_files` 返回每条的 `remap` 字段（`{original, reason, mode}`），
  重映射顺序：占位符解码 → 旧 workspace 名/目录名匹配 → 旧 profileDir/dshHome 前缀 → 旧 homeDir 前缀 →
  `<当前 DSH_HOME>/restore-external/<文件名>` fallback；无法映射的条目不写回。
- `manifest.plugins[].packed/codeArchivePath/codeTarget` 表示插件代码本体是否入包及恢复目标；
  `manifest.snapshotPolicy = { packPluginCode, credentialsIncluded, pluginCodePacked[] }`。
- 恢复流程末尾：恢复 AI 必须调用一次 `restore_reinstall_dependencies`；Host 在 AI 结束后**机械性强制执行一次**
  `dsh plugin --profile <name> install`（失败回退 `pnpm install`），结果写入 `run.summary`。

## 17) DSH 主 Agent 工具（2026-11-05 第二轮新增）

插件向主 Agent 注册两个工具（非 HTTP，仅在 DSH 会话内可用）：
- `backup_all_create_snapshot({ name?, description? })` → 后台启动快照，返回 `runId`。
- `backup_all_restore_snapshot({ id?, name?, confirm: true })` → 后台启动恢复，返回 `runId`。
工具描述里明确标注「非用户明确要求不得调用 / 不得主动建议」；恢复工具强制 `confirm: true`。

---

## 17. v1.1.0 新增契约：跨平台 / 导入导出（2026-11-06）

### 17.1 记录字段新增
`GET /dsh-backup-all/state` 的 `records[]` / `archived[]` 新增：
- `osType: 'linux'|'windows'|'other'|'unknown'`（unknown = 旧版/无系统类型记录；UI 显示「旧版」）
- `imported: boolean`（true = 通过「引入快照」导入）

`GET /state` 顶层新增 `currentOs`（当前机器 osType），供 UI 判断/展示。

### 17.2 快照文件名
- 新快照：`{YYYY-MM-DD HH-mm-ss}-{osType}.backup.tar.br`（osType 小写 token；如 `2026-11-06 10-30-00-linux.backup.tar.br`）。
- 冲突：同秒同名追加 `-1`、`-2`（插在 `.backup.tar.br` 之前）。
- 导入文件：保留原文件名（清洗 Windows 非法字符/保留名/尾点空格），冲突同样加 `-n`。

### 17.3 GET `/dsh-backup-all/snapshot/export?id=<recordId>`
- 鉴权：同现有 fail-closed cookie 鉴权。
- 成功 200：`content-type: application/octet-stream`、`content-disposition: attachment; filename*=UTF-8''<encoded>`、`content-length`，流式返回归档字节。
- 失败 404 + JSON `{ok:false,error}`（找不到/文件不存在/非法文件名）。

### 17.4 POST `/dsh-backup-all/snapshot/import`
- Body：归档原始字节（`application/octet-stream`），上限 **512 MiB**。
- Headers（UTF-8 percent-encoded，缺失时用兜底）：
  - `x-snapshot-filename`（原始文件名）
  - `x-snapshot-name`（展示名；缺省 = 文件名去掉 `.backup.tar.br` / `.tar.br`）
  - `x-snapshot-description`
- Host 流式写入 `backup/.cache/` 临时文件 → 校验（Brotli/tar 可读、`manifest.json` 存在且可解析）→ 移入 `backup/` 登记记录；失败清理临时文件。
- 成功 200 JSON `{ok:true, record}`；失败 200 JSON `{ok:false,error}`。

### 17.5 `restore_compare` 新增 `compatibility`
```json
{"snapshotOs":"linux","currentOs":"windows","mode":"linux-to-windows","supported":true,
 "strategy":"compat-linux-to-windows","restrictions":["skip-plugin-code","skip-symlinks","reinstall-registry-only"],"notes":["…"]}
```
- `mode`：`same-linux|same-windows|linux-to-windows|windows-to-linux|unknown`
- `strategy`：`full|full-windows|compat-linux-to-windows|compat-windows-to-linux|blocked`
- Host 在 `restore_apply_files` 内强制执行 restrictions：跨 OS 跳过 `plugin-code` 条目与符号链接；`blocked` 时 ok:false 且不写任何文件；返回 `skipped[]`/`warnings[]`。

### 17.6 符号链接解包
`lib/archive.js extractArchive({symlinkPolicy:'auto'|'copy'|'skip'})`：
- `auto`（默认）：Windows 等创建 symlink 失败（EPERM/EACCES/ENOTSUP/…）时降级：目标已解包 → 复制文件/目录，否则跳过并 warning；
- copy/skip 的待复制项在所有条目解包完后统一处理（目标可能在链接之后出现）；
- 返回值新增 `warnings: string[]`。

## 18. v1.2.0 新增：Windows→Linux 兼容恢复

- `compatibility` 矩阵新增 `mode=windows-to-linux`、`strategy=compat-windows-to-linux`、`supported=true`；`restrictions` 同跨 OS：`skip-plugin-code` / `skip-symlinks` / `reinstall-registry-only`。
- Host 在 `restore_apply_files` 内强制执行 restrictions；profile `package.json` 写回时：`dsh-backup-all` 自身 spec 统一为当前机 spec；其他 Windows `link:/file:` 绝对路径依赖移除并写 `warnings`；`dsh.profile.bundles` 同步清理。
- 解包阶段：Host 会移除符号链接/junction（跨 OS）；解包权限兜底：Windows 归档的 0666 目录/文件在 POSIX 上补 `read`/`exec` 位，避免目录不可遍历。
- 路径映射：Windows 盘符绝对路径（如 `C:\\work\\fixture-data`）在 Linux 上落到 `<DSH_HOME>/restore-external/<name>-<hash>`，`restore_apply_files` 返回 `warnings`。
- `blocked` 保留为未来未定义组合的兜底；当前四场景均 `supported=true`。
- **v1.3.0 可选增强**：设置 `snapshot.crossOsPluginCode`（`skip` 默认 | `js`）控制跨 OS 插件代码策略；`js` 时 `compatibility.restrictions` 用 `plugin-code-js-only` 替代 `skip-plugin-code`，Host 对每个 `plugin-code` 目录做纯 JS 分类（`lib/plugin-code.js`：拒绝 `.node/.dll/.exe` 等原生文件、符号链接、`os/cpu` 不匹配、`gypfile`、未知扩展、文件数>3000/体积>64MB），通过才写回，否则 skipped + warnings。
