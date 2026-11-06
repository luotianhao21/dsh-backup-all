# UI 规格 — dsh-backup-all 客户端（qwen3.8-max 实现）

文件：`client.js`（唯一 UI 文件，纯 JS，无构建）、`icon.svg`、`locale/en.json`、`locale/zh.json`。
**必须严格按本文档实现**；Host API 见 `docs/API-CONTRACT.md`、整体架构见 `docs/ARCH.md`。

## 0. 客户端 bundle 硬约束（DSH 机制，违反会白屏）

```js
// client.js 整体形状（纯 JS，不能用 JSX/TS/import）
window.__ModuleLoader__.load({
  id: 'dsh-backup-all',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ... 所有代码在这里（可以用 function/const 组织）...
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'backup-all', order: 25, label: 'Backup ALL',
        }, BackupAllSection));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'backup-all-floating', order: 60,
        }, FloatingBall)));
      },
    };
  },
});
```

- 只能用 `require('react')`（可用 `React.useState/useEffect/useRef/useMemo/useCallback`、`React.createElement`、`React.Fragment`），
  **不要** import 任何 `@deepseek-ai/*`、不要 require('react-dom')、不要操作 document.body、不要读写别人的 DOM。
- 样式：React 内联 style 对象 + **一个**用组件内渲染的 `<style>` 元素（`h('style', {dangerouslySetInnerHTML:{__html: CSS}})`，或把 CSS 字符串放在模块常量里）。
  类名前缀统一 `dswba-`。颜色**只用**下面列出的主题 token（`var(--dsw-alias-*)`），状态色可少量用语义 token；
  唯一允许的写死颜色是版本徽章的绿色底/字（见下）与截图类的图标描边可用 `currentColor`。
- 图标：内联 SVG 组件（`h('svg', {...}, h('path',{...}))`），16px（按钮内）/18px，`stroke:'currentColor'`, `fill:'none'`, `strokeWidth:1.6`, `strokeLinecap:'round'`, `strokeLinejoin:'round'`。
- 所有可见文案中文（英文 locale 只用于插件管理元数据）。
- 组件里禁止副作用式 DOM 操作；所有 setInterval/fetch 放在 `useEffect` 并清理。轮询用模块级单例 store（见下），避免两个组件各自轮询。
- 组件不能抛错（上层 slot 崩了会空白）：所有 fetch/JSON 都 try/catch，字段用可选链兜底。

主题 token（已确认存在）：
`--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`, `--dsw-alias-bg-overlay`,
`--dsw-alias-border-l1`, `--dsw-alias-border-l2`, `--dsw-alias-brand-primary`, `--dsw-alias-label-primary`,
`--dsw-alias-label-secondary`, `--dsw-alias-state-error-primary`, `--dsw-alias-state-idle-primary`,
`--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-primary`, `--dsw-specific-sidebar-fill`

## 1. 设置页：`settings.section`（组件 `BackupAllSection`）

设置窗口内容区一页。根容器 `width:100%; height:100%; display:flex; flex-direction:column; padding:20px 24px; box-sizing:border-box; overflow:auto; color:var(--dsw-alias-label-primary)`。

### 1.1 页头（固定顶部）
- 左：`Backup ALL` 大字（`font-size:20px; font-weight:650`）+ 版本徽章：紧贴右侧，圆角 `border-radius:999px; padding:1px 9px; font-size:12px; font-weight:600;`，
  **淡绿底 + 绿字**（写死颜色 `background:rgba(46,160,67,.16); color:#2ea043`；暗色模式同一组颜色也可读）。
  文案：`v{state.version}`。
- 右：`快照文件已占用 {formatSize(state.totalBytes)}`，`font-size:12.5px; color:var(--dsw-alias-label-secondary)`；下方可放一行更小的「共 N 个快照」。
- 页头下方 12px 分隔。

### 1.2 水平导航栏（两页）
- 一个横向 tab 行：`快照列表`、`高级设置`（顺序固定）。选中项：文字主色 + 底部 2px `var(--dsw-alias-brand-primary)` 下划线；未选中：`--dsw-alias-label-secondary`。
- 点击切换内容页（本地 state `tab: 'snapshots' | 'advanced'`）。切页不打断正在运行的任务（轮询在 store 里）。

### 1.3 「快照列表」页
页面内顶部工具栏（flex，间距 8px，垂直居中）：
1. 搜索框：左侧放大镜图标，placeholder `搜索快照名称 / 描述`；输入即过滤（本地 filter，name+description 不区分大小写）；宽度弹性（flex:1，max 320px），高 32px，圆角 8px，边框 `--dsw-alias-border-l1`，背景 `--dsw-alias-bg-base`。
2. `+ 创建新快照`：主按钮（背景 `--dsw-alias-brand-primary`、白字、圆角 8px、高 32px、padding 0 14px、字号 13px、图标加号）。
3. `已归档`按钮：右对齐，带归档图标，次要按钮（透明底、边框 l1、文字 secondary）；点击进入「已归档」视图。
   （工具栏下方若有正在运行的任务，显示一条状态条：左侧旋转小圆点 + `正在创建快照：{run.snapshotName} — {run.phase} {run.progress}%`，点击打开进程窗口。）

卡片网格：`display:grid; grid-template-columns:repeat(auto-fill, minmax(300px,1fr)); gap:12px; margin-top:14px;`。
**空状态**：无快照时显示居中提示（大号存档图标 + `还没有快照` + `点击右上角「创建新快照」开始`）。

### 1.4 快照卡片
容器：`background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; padding:14px; display:flex; flex-direction:column; min-height:150px; position:relative;`。
从上到下：
1. 名称：左上，加大加粗（`font-size:15px; font-weight:650`，单行省略号，`title` 属性全名）。
2. 时间：**紧贴名称下方**（`margin-top:2px; font-size:11px; color:var(--dsw-alias-label-secondary); opacity:.85`），格式 `YYYY-MM-DD HH:mm:ss`（由 createdAt 本地时区格式化）。
3. 描述：`margin-top:10px; font-size:12.5px; line-height:1.55; color:var(--dsw-alias-label-secondary); text-align:left; flex:1;`
   最多显示 3 行（`display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-wrap; word-break:break-word`）。空描述显示 `（无描述）`。
4. 底部行（`margin-top:12px; display:flex; align-items:center; justify-content:space-between; gap:8px`）：
   - 左：文件大小，自适应 KB/MB/GB（`formatSize(bytes)`，`font-size:11.5px; color:var(--dsw-alias-label-secondary)`）。
   - 右：三个按钮：`编辑`、`归档`、`恢复`（图标+文字，高 26px，padding 0 8px，圆角 7px，字号 12px，透明底，hover 时 `background:var(--dsw-alias-bg-layer-2)`）。
     - 编辑：打开编辑弹窗（名称、描述，可复用创建弹窗的表单样式；底部「保存」）。
     - 归档：`POST /snapshot/archive {id, archived:true}`，成功刷新；（已归档视图里同一按钮显示「取消归档」，发 archived:false）。
     - 恢复：打开恢复窗口（见 1.7）。
5. `kind === 'pre-restore'` 的卡片额外差异：
   - 卡片顶部加一个小标签 `恢复前快照`（圆角小徽章，淡橙底 `rgba(210,153,34,.16)`、字色 `#d29922`）。
   - **固定排在列表最前**（Host 已保证顺序；客户端也按 kind 排序兜底）。
   - 底部比其它卡片**多一个按钮**：`保存为永久快照`（整行宽，次要按钮，位于底部行上方，带保存图标）。点击弹窗填名称/描述 → `POST /snapshot/promote`。
   - 卡片上额外显示「恢复中已创建」小字？不需要。

### 1.5 「已归档」视图
- 顶部：返回按钮 `← 返回快照列表` + 标题 `已归档`（14px 粗体）+ 右侧数量。
- 卡片复用快照卡片，但操作区只有：`取消归档`、`删除`（删除按钮用 error 色文字，点击二次确认弹窗「删除后压缩包文件也会被删除，确定？」）。
- 空状态：`没有已归档的快照`。

### 1.6 创建快照流程（两步）
**第 1 步 弹窗**（组件内 state `createOpen`，居中 modal，遮罩 `rgba(0,0,0,.45)`，z-index 高；卡片 `background:var(--dsw-alias-bg-overlay)`、圆角 14px、宽 440px、padding 20px）：
- 标题 `创建新快照`。
- 名称输入：label `快照名称`，**默认值为当前时间**，格式 `YYYY-MM-DD HH-mm-ss`（注意是本地时间、时-分-秒用连字符）；maxLength 200。
- 描述 textarea：label `快照描述`，placeholder `记录这次快照的内容 / 为什么创建…`，3 行，maxLength 2000。
- 右下角按钮：`下一步`（主按钮）。点下一步：若名称空则内联报错；并检查 `state.settings.ai.configured`，未配置则提示 `请先在「高级设置」中配置 AI 模型`（并在提示旁给 `去配置` 链接按钮 → 切到高级设置页）。
- 支持 Esc 关闭、点遮罩关闭（运行中不可关闭）。

**第 2 步 AI 创建窗口**（`createOpen === 'running'`，仍在设置页内渲染为一张卡片/弹窗，宽 100% 最大 720px，或直接整页替换列表区——推荐居中弹窗 760px 宽）：
- 顶部：标题 `创建快照：{name}`，右上角小字 `AI 正在工作…`。
- **AI 内容输出窗口**：高 280px，`background:var(--dsw-alias-bg-base)`，边框 l1，圆角 10px，`overflow:auto; padding:10px 12px; font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word`。
  - 每行前缀按 kind 着色：`assistant` 主文字；`tool` secondary（可加 `› ` 前缀）；`system` brand 色（`▸ ` 前缀）；`error` error 色。
  - 新行自动滚动到底（若用户已向上滚动则不强制，可用简单 `scrollTop = scrollHeight` 在内容变化时执行）。
- **多功能按钮**（核心，高度 44px，宽 100%，圆角 10px，相对定位，`overflow:hidden`，`transition: background .2s; user-select:none`）：
  - 状态 `idle`：蓝色主按钮 `创建快照`（背景 `var(--dsw-alias-brand-primary)`，白字，居中）。点击 → `POST /snapshot/create` → 进入 `running`。
  - 状态 `running`：背景蓝（brand），**文字居中层** `{progress}%  {phase}`（左侧可放小旋转指示器）；**底层进度填充**：绝对定位的 div，`left:0; top:0; bottom:0; width:{progress}%`，背景 `rgba(255,255,255,.22)`，`transition:width .25s ease`；**动画强调层**：在进度填充右边缘放一个 `width:120px; background:linear-gradient(90deg, transparent, rgba(255,255,255,.38), transparent)` 的斜向流光条（`animation: dswba-sheen 1.4s linear infinite`），覆盖在按钮背景上强调当前进度位置。
  - hover running：按钮背景变淡红（`rgba(218,54,51,.82)` 或 `#da3633d0`），文字变 `中断快照`（居中，替换进度文字，但保留进度填充可见）。
  - 点击（hover 时）→ `POST /snapshot/abort` → 状态 `interrupting`：背景淡红，进度从当前值**缓慢回退到 0**（用 setInterval 每 50ms 减约 2~3，约 1.2s；或按初值/1200ms 比例），文字 `正在中断…`；回退到 0 后状态 `interrupted`：背景实红（`var(--dsw-alias-state-error-primary)`），文字白色 `中断快照成功`；下方出现 `关闭` 按钮（次要按钮）。再点按钮无动作。
  - 状态 `done`：淡绿（`rgba(46,160,67,.18)`，文字绿色 `#2ea043`，边框 1px 绿色），文字 `快照完成`；**进度条下面添加一个 `关闭` 按钮**（次要按钮，点击关闭窗口并刷新列表/回列表页）。
  - 状态 `failed`：淡红底 error 字 `快照失败`；下方显示 error 文案（小字）+ `关闭` 按钮。
  - 状态同步来源：store 的 `run`（`status/progress/phase/message`）；本地有一个 `uiPhase` 覆盖（click 后立即切到 `starting` 防止重复点击）。
- 关闭行为：done/failed/interrupted 后可关闭；running/interrupting 时点右上角 × 应先确认「任务仍在进行，关闭窗口后可在悬浮球继续查看」。

### 1.7 恢复窗口（点击卡片「恢复」）
与创建窗口同款布局（输出窗口 + 多功能按钮），标题 `恢复快照：{record.name}`。
- 文案强调：`恢复前会先自动为当前环境创建「恢复前快照」，恢复过程中可中断。`
- idle 按钮文字 `开始恢复`（蓝色）；点击 `POST /restore/start {id}` → running（进度按钮，hover 显示 `中断恢复`）；中断语义同创建；完成显示淡绿 `恢复完成` + 下方「关闭」+ 一行提示 `部分插件变更需要重启 DSH 后生效`。
- 运行中列表也会更新（恢复前快照会出现在第一位）。

### 1.8 「高级设置」页
1. **AI 配置长按钮**（整行宽、高 56px、圆角 10px、边框 l1、背景 layer-1、`display:flex; align-items:center; justify-content:space-between; padding:0 16px; cursor:pointer`）：
   - 左：`AI 配置`（14px 粗体）+ 下方小字 `用于创建快照与恢复的独立模型`（11.5px secondary）。
   - 右：状态区 —— 未配置时 `未配置`（secondary）；已配置时：状态圆点（连通：绿 `--dsw-alias-state-success-primary`；失败：红 error；未测试：灰 idle）+ 小字 `{modelId}`。
   - 点击展开/收起配置表单。
2. **展开的配置表单**（卡片背景 layer-1，圆角 10px，padding 16px，字段两列网格 `grid-template-columns:1fr 1fr; gap:12px 16px`，窄屏单列）：
   - `API Base URL`（整行，placeholder `https://…/v1`）
   - `API 协议`（下拉：`OpenAI 兼容 (Chat Completions)` = `openai-completions`；`Anthropic Messages` = `anthropic-messages`）
   - `API Key`（密码输入，placeholder 已存时显示 `已保存（留空则不修改）`；右侧可加显示/隐藏小眼睛按钮）
   - `AI Model ID`（文本）
   - `上下文窗口大小`（数字输入 + 单位下拉 `K`/`M`，默认 `1000000` → 若为 1000000 显示 `1000 K`？—— 统一：内部存 token 数，表单显示时若能被 1024*1024 整除优先 M，否则除以 1000 显示 K 并选择 K；**显示规则**：≥1,000,000 用 M（值=token/1000000，如 1000000→1M 不好看；用 1,000,000 → `1000 K`）。简化：默认显示值 `1000`、单位 `K`；保存时 token = 数值 × (K?1000:1000000)。回填：token/1000 若为整数则 K，否则 /1000000 若为整数则 M。)
   - `最大输出大小`（同上，默认 `64 K`）
   - `Effort Level`（下拉：`off/low/high/max`，默认 `max` 选中）
   - 底部一行（`grid-column:1/-1; display:flex; gap:10px; justify-content:flex-end`）：`测试模型接通性`（次要按钮）、`保存`（主按钮）。
   - 测试结果：按钮左侧或下方内联文本：成功 `连接成功 · {latencyMs}ms · {modelId}`（绿色）；失败 `连接失败：{error}`（红色）。测试中按钮禁用 + 文案 `测试中…`。
   - 保存成功后 toast/内联 `已保存`（2s 后消失）。
3. **快照策略卡片**（位于 AI 配置长按钮下方、清除所有快照上方；Host 已实现契约）：
   - 卡片标题「快照策略」+ 副标题「决定快照里是否带插件代码本体 / 凭据」。
   - 第一行 label「插件代码本体」+ 下拉：`仅打包本地不可再下载插件（推荐）` / `打包全部插件代码` / `不打包插件代码`，对应 `packPluginCode = local-only | all | none`；下方小字随选择动态换说明（默认 local-only 文案：file:/link: 来源的本地插件代码会一并打包；registry/安装自带插件只记来源，恢复时重装）。
   - 第二行 label「不打包凭据」+ 开关（`role="switch"`、`aria-checked`）：对应 `excludeCredentials`；开启时小字警示「不打包 .credentials.yaml，恢复后需重新填写 API Key / 账号凭据」，关闭时「凭据文件会原样入包（明文），恢复后请轮换密钥」。
   - 卡片右下「保存」：仅提交 `{ snapshot: { packPluginCode, excludeCredentials } }`；成功内联「已保存」2 秒 + toast。
   - 初值从 `state.settings.snapshot` 回填；设置变化时同步但不打断用户输入。
4. **清除所有快照**：整行宽长按钮（高 52px，红色边框/红字，白/透明底，hover 淡红底），文案 `清除所有快照`，副标题小字 `删除全部压缩包与记录，不可恢复`。点击二次确认弹窗：标题 `清除所有快照？`，正文 `将删除 {N} 个快照及其压缩包文件，此操作不可恢复。`，按钮 `取消` / `确认清除`（红色主按钮）。成功后刷新 state，显示 `已清除 N 个快照`。

## 2. 悬浮球（`shell.overlay`，组件 `FloatingBall`）

- 仅在存在「值得关注」的 run 时显示：`run` 且 `status === 'running'`（或本地记录了刚中断/刚完成的短窗口 3s）。
- 位置：`position:fixed; right:10px; top:50%; transform:translateY(-50%)`；尺寸 48px；`border-radius:50%`；
  `background:var(--dsw-alias-bg-overlay)`；`border:1px solid var(--dsw-alias-border-l2)`；`box-shadow:0 4px 16px rgba(0,0,0,.28)`；`cursor:pointer`。
- 内容：一个 SVG 圆环进度（`r=20, circumference`，stroke `var(--dsw-alias-brand-primary)`，`stroke-dasharray={C}`，`stroke-dashoffset={C*(1-p/100)}`，`transform:rotate(-90deg)`）+ 居中百分比小字（10px，`{progress}%`）。下方/内部可加 `快照` 小字？保持简洁：环内 `{progress}%`。
- 点击打开**快照进程窗口**：固定在右下或居中偏右的浮层（宽 520px、高 420px，`background:var(--dsw-alias-bg-overlay)`，圆角 14px，边框 l1，阴影，overlay 层 z-index 较高且 `pointerEvents:'auto'`）：
  - 标题行：`{kind==='restore'?'恢复快照':'创建快照'} · {snapshotName}` + 右上角关闭 ×。
  - 输出窗口（同 1.6 的样式，flex:1 滚动）。
  - 多功能按钮（同 1.6 状态机，复用同一个组件 `RunButton`）。
  - 完成后（done）显示 `关闭` 且悬浮球在 3 秒后消失。
- 注意 `shell.overlay` 容器本身点击穿透，所以根元素需要 `style.pointerEvents='none'`，球和窗口各自 `pointerEvents='auto'`。
- 悬浮球与进程窗口共享模块级 store 数据，不要各自轮询。

## 3. 模块级 store（client.js 内）

```js
const STORE = {
  state: null, log: [], cursor: 0, listeners: new Set(), refs: 0, timer: null, logTimer: null,
  subscribe(fn){...}, get(){...}, notify(){...},
  start(){ refs++; if(timer) return; pollState(); timer=setInterval(pollState,600); logTimer=setInterval(pollLog,450); },
  stop(){ if(--refs>0) return; clearInterval(...); ... },
};
async function fetchState(){ try{ const r=await fetch('/dsh-backup-all/state',{cache:'no-store'}); const j=await r.json(); if(j.ok){ STORE.state=j; ... } }catch{} }
async function fetchLog(){ const run=STORE.state?.run; if(!run || run.status!=='running') return; ... fetch(`/dsh-backup-all/log?since=${STORE.cursor}&runId=${encodeURIComponent(run.id)}`) ... append, cursor=j.cursor; notify(); }
```
- 组件用 `useEffect(() => STORE.subscribe(setTick), [])` + `STORE.start()/stop()` 引用计数。
- 所有 POST 用 `postJSON(path, body)` 封装：返回 `{ok, ...}`，失败抛/返回 error 给 UI 内联显示。
- `formatSize`: 1024 进制，`B/KB/MB/GB`，≥1 位小数、去尾 `.0`。
- 时间格式化：`new Date(iso)` → 本地 `YYYY-MM-DD HH:mm:ss`。
- 默认快照名生成：本地时间 `YYYY-MM-DD HH-mm-ss`。

## 4. 组件清单（建议）

`BackupAllSection`（页头+导航+两页路由）、`SnapshotsPage`、`ArchivedPage`、`SnapshotCard`、`CreateDialog`（第 1 步）、
`RunWindow`（第 2 步 / 恢复窗口通用：输出+RunButton）、`RunButton`（多功能按钮状态机）、`AdvancedPage`、`AiConfigForm`、
`ConfirmDialog`、`FloatingBall`、`FloatingRunPanel`、`Icon` 系列、`Toast`（简单内联提示即可）。

## 5. 交付自检（qwen 自己跑）

- `node --check client.js` 通过（ESM 语法；注意 Node 会按 package.json type=module 解析，`window` 只是运行期对象，语法检查不需要它）。
- 文件里不含 `import ` 语句、不含 JSX 尖括号语法、不含 `@deepseek-ai/` 引用。
- 检查所有 fetch 路径都以 `/dsh-backup-all` 开头。
- 所有状态分支（idle/running/interrupting/interrupted/done/failed；列表空/已归档空/未配置 AI）都有渲染分支。
- 输出一段「组件与状态覆盖清单」给 Lead。

---

## v1.1.0 新增 UI（跨平台快照 / 引入导出 / OS 徽章）

### 1. 工具条：引入快照
- 位置：快照列表工具条，搜索框 / 「创建新快照」旁；次要按钮样式（与「已归档」一致）。
- 点击打开弹窗（复用 Modal）：
  1. 文件选择行：`选择快照文件（.backup.tar.br）`，选中后显示文件名（过长省略，title 全文）；支持点击重新选择。
  2. 名称输入：默认 = 文件名去掉 `.backup.tar.br` / `.tar.br` 后缀（保留 `-linux/-windows` 部分，如 `2026-11-06 10-30-00-linux`）；可编辑，最长 200 字。
  3. 描述 textarea（可空，最长 2000 字）。
  4. 按钮：取消 / 引入；上传中按钮禁用并显示「引入中…」，失败在弹窗内红字显示错误。
- 上传：POST `/dsh-backup-all/snapshot/import`，headers `x-snapshot-filename` / `x-snapshot-name` / `x-snapshot-description`（`encodeURIComponent`），body 为 File；成功后 toast + 刷新列表。
- 记录标记：`imported:true`；卡片正常参与搜索/编辑/归档/导出/恢复/删除。

### 2. 每张卡片：导出按钮
- 与「编辑 / 归档 / 恢复」同组，图标下载；点击 fetch 导出接口 → Blob → `<a download=record.file>` 下载；按钮显示「导出中…」并禁用；失败 toast。
- 窄屏（≤480px）：按钮组可换行，顺序保持（编辑/归档/恢复/导出）。

### 3. OS 徽章
- 位置：卡片名称行（名称右侧），18px 高、圆角 4px、11px 字号、白字：
  - `windows` → 蓝底（如 `#2563eb`）「Windows」；
  - `linux` → 橙底（如 `#ea580c`）「Linux」；
  - `unknown`/缺失 → 灰底（如 `#6b7280`）「旧版」；
  - `other` → 灰底「Other」。
- 引入记录同样显示（依据 `/state` 的 `osType` 字段）。


## v1.3.0 · 高级设置新增「跨 OS 恢复插件代码」下拉

位置：高级设置 →「快照策略」卡片，在「不打包凭据」行之后新增一行：

- label：`跨 OS 恢复插件代码`
- 控件：自建锚定 SelectBox（id `dswba-snap-cross-os-code`，aria-label 同名），选项：
  1. `跳过（默认，安全）` → 值 `skip`
  2. `尝试迁移纯 JS 插件代码（实验性）` → 值 `js`
- 动态提示：
  - skip：跨 OS 恢复时不写回任何插件代码（含原生二进制/符号链接的插件需在目标机重装）。
  - js：Host 逐个校验插件代码：纯 JS（无原生二进制、无平台限制）才写回；含 .node/.dll/.exe 等或 package.json os/cpu 不匹配的条目仍跳过并写警告。
- 保存时与 `packPluginCode`、`excludeCredentials` 一起提交到 `POST /dsh-backup-all/settings` 的 `snapshot` 字段。
