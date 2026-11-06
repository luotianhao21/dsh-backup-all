/**
 * lib/prompts.js —— 快照 AI / 恢复 AI 的提示词装配（零第三方依赖）。
 *
 * 设计要点：
 * - 系统提示词正文放在 prompts/*.md，便于人工审阅与版本对比；本模块只负责读取。
 * - 用户提示词只注入「摘要 + 关键路径 + 开工顺序」，完整数据一律交给工具按需获取，
 *   避免把整份 inventory / manifest 塞进上下文（可能几十 KB）。
 * - 注入的任何配置都先做敏感字段过滤：API Key / token / 凭据值一律不进提示词。
 */

import { readFileSync } from 'node:fs';

const PROMPT_BASE = new URL('../prompts/', import.meta.url);

/** 提示词加载失败时使用的兜底：宁可让 AI 明确拒绝执行，也不让整个插件 import 失败。
 *  （模块顶层抛错不会被 index.js 的 try/catch 接住，会直接让 Loader fiber 失败。） */
export const PROMPT_LOAD_ERRORS = [];

function loadPrompt(fileName, fallback) {
  try {
    const url = new URL(fileName, PROMPT_BASE);
    const text = readFileSync(url, 'utf8').trim();
    if (!text) throw new Error(`提示词文件为空：prompts/${fileName}`);
    return text;
  } catch (error) {
    const message = String((error && error.message) || error);
    PROMPT_LOAD_ERRORS.push(fileName + ': ' + message);
    try {
      console.error('[dsh-backup-all] 提示词加载失败：' + message);
    } catch {}
    return (
      fallback +
      '\n\n[配置错误] 提示词文件加载失败：' + message +
      '\n请立即停止：不要调用任何工具、不要写文件、不要打包或恢复，只向用户报告「插件提示词文件缺失或损坏：' + fileName + '」。'
    );
  }
}

/** 快照 AI 系统提示词（正文见 prompts/snapshot-system.md）。 */
export const SNAPSHOT_SYSTEM_PROMPT = loadPrompt('snapshot-system.md', '# DSH 环境快照 AI（降级模式）');

/** 恢复 AI 系统提示词（正文见 prompts/restore-system.md）。 */
export const RESTORE_SYSTEM_PROMPT = loadPrompt('restore-system.md', '# DSH 环境恢复 AI（降级模式）');

/**
 * Host 中断时注入给 AI 的指令文本（快照/恢复共用，runner 作为一条 user 消息追加）。
 * 必须一句话说清「立即停止、不要调用收尾工具、不要写文件」。
 */
export const INTERRUPT_INSTRUCTION =
  'INTERRUPT_INSTRUCTION：用户已中断本次任务。立即停止一切动作——不要再调用任何工具'
  + '（快照任务尤其禁止 backup_build、backup_add_path、backup_set_restore_plan、backup_write_restore_doc；'
  + '恢复任务尤其禁止 restore_apply_files、restore_reinstall_dependencies、restore_finish），'
  + '不要写入、修改或删除任何文件，不要继续探索或重试。\n'
  + '只回复一句：「已停止：未执行打包/写回，未改动任何文件。」然后结束。';

/** 单个用户提示词的字符上限（防止极端环境下清单过大撑爆上下文）。 */
const MAX_USER_PROMPT_CHARS = 18000;

/** 摘要里每类数组最多保留的条数。 */
const CAP = {
  configFiles: 20,
  bundles: 40,
  plugins: 40,
  patchRows: 30,
  mcpRows: 20,
  presetRows: 20,
  presetRegistryRows: 10,
  skills: 40,
  skillRoots: 12,
  externalCandidates: 40,
  excluded: 12,
  warnings: 8,
  files: 30,
};

const ENV_KEYS = [
  'version',
  'dshHome',
  'profileName',
  'profileDir',
  'dshVersion',
  'pluginRoot',
  'backupDir',
  'pluginPackageName',
  'platform',
  'nodeVersion',
  'hostname',
  'nodeModulesDir',
];

/** 形似密钥的配置键：用户提示词里一律不注入。 */
const SECRET_KEY_RE = /(api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|token$|secret|password|passwd|authorization|cookie|session)/i;

const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const toArr = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));

function firstStr(...values) {
  for (const value of values) {
    const text = toStr(value).trim();
    if (text) return text;
  }
  return '';
}

/** 压成单行、截断；用于表格/摘要里的长字符串。 */
function clipText(value, max = 200) {
  const text = toStr(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 去掉 undefined / null / 空串 / 空数组，保证 JSON 干净。 */
function compactObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** 截断数组并附带「总数/是否截断」信息。 */
function capList(list, max) {
  const source = toArr(list);
  return { rows: source.slice(0, max), total: source.length, truncated: source.length > max };
}

function stringifyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '"(无法序列化)"';
  }
}

/** 只保留可读、非敏感的环境字段。 */
function sanitizeEnv(source) {
  if (!isObj(source)) return {};
  const out = {};
  for (const key of ENV_KEYS) {
    if (source[key] !== undefined && source[key] !== null) out[key] = clipText(source[key], 260);
  }
  let extras = 0;
  for (const [key, value] of Object.entries(source)) {
    if (extras >= 8) break;
    if (ENV_KEYS.includes(key) || SECRET_KEY_RE.test(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = clipText(value, 160);
      extras += 1;
    }
  }
  return out;
}

/**
 * 把完整 inventory 压成「足够 AI 起步」的摘要。
 * 只给数量统计 + 关键路径，配置原文让 AI 用 backup_read_text 读。
 */
function summarizeInventory(inventory) {
  if (!isObj(inventory)) {
    return { note: 'Host 未提供 inventory；请先调用 backup_get_inventory 读取完整清单。' };
  }

  const count = (value) => toArr(value).length;
  const configFiles = capList(inventory.configFiles, CAP.configFiles).rows.map((item) => compactObject({
    path: clipText(item?.path, 200),
    role: toStr(item?.role),
    exists: item?.exists !== false,
    bytes: typeof item?.bytes === 'number' ? item.bytes : undefined,
  }));

  const bundles = capList(inventory.bundles, CAP.bundles).rows.map((item) => compactObject({
    name: toStr(item?.name),
    version: toStr(item?.version),
    availability: toStr(item?.availability),
    enabled: item?.enabled === true ? true : undefined,
    installed: item?.installed === true ? true : undefined,
    rows: toArr(item?.rows).map((row) => toStr(row?.rowId ?? row)).filter(Boolean),
  }));

  const plugins = capList(inventory.plugins, CAP.plugins).rows.map((item) => compactObject({
    name: toStr(item?.packageName ?? item?.name),
    version: toStr(item?.version),
    kind: toStr(item?.kind),
    spec: clipText(item?.spec, 160),
    linkTarget: clipText(item?.linkTarget, 200),
    externalToProfile: item?.externalToProfile === true ? true : undefined,
  }));

  const simpleRows = (list, max) => capList(list, max).rows.map((item) => compactObject({
    file: clipText(item?.file, 200),
    rowId: toStr(item?.rowId ?? item?.id),
    name: toStr(item?.name),
    disabled: item?.disabled === true ? true : undefined,
  }));

  const skills = capList(inventory.skills, CAP.skills).rows.map((item) => compactObject({
    name: toStr(item?.name),
    path: clipText(item?.path, 200),
    root: clipText(item?.root, 200),
    source: toStr(item?.source),
    external: item?.external === true ? true : undefined,
  }));

  const skillRoots = capList(inventory.skillRoots, CAP.skillRoots).rows.map((item) => compactObject({
    path: clipText(item?.path, 200),
    source: toStr(item?.source),
    exists: item?.exists !== false,
    count: typeof item?.count === 'number' ? item.count : undefined,
  }));

  const externalCandidates = capList(inventory.externalCandidates, CAP.externalCandidates).rows.map((item) => compactObject({
    path: clipText(item?.path, 220),
    kind: toStr(item?.kind),
    why: clipText(item?.why, 180),
  }));

  const excluded = capList(inventory.excluded, CAP.excluded).rows.map((item) => compactObject({
    path: clipText(item?.path, 200),
    why: clipText(item?.why, 120),
  }));

  const warnings = capList(inventory.warnings, CAP.warnings).rows
    .map((item) => clipText(item, 200))
    .filter(Boolean);

  const truncation = isObj(inventory.counts) ? { ...inventory.counts } : {};
  for (const [key, total] of Object.entries({
    configFiles: count(inventory.configFiles),
    bundles: count(inventory.bundles),
    plugins: count(inventory.plugins),
    patchRows: count(inventory.patchRows),
    mcpRows: count(inventory.mcpRows),
    presetRows: count(inventory.presetRows),
    presetRegistryRows: count(inventory.presetRegistryRows),
    skills: count(inventory.skills),
    skillRoots: count(inventory.skillRoots),
    externalCandidates: count(inventory.externalCandidates),
    excluded: count(inventory.excluded),
    warnings: count(inventory.warnings),
  })) {
    if (total > 0) truncation[key] = total;
  }

  return compactObject({
    generatedAt: clipText(inventory.generatedAt, 40),
    dshHome: clipText(inventory.dshHome, 220),
    profileName: toStr(inventory.profileName),
    profileDir: clipText(inventory.profileDir, 220),
    dshVersion: clipText(inventory.dshVersion, 60),
    counts: truncation,
    configFiles,
    bundles,
    plugins,
    patchRows: simpleRows(inventory.patchRows, CAP.patchRows),
    mcpRows: simpleRows(inventory.mcpRows, CAP.mcpRows),
    presetRows: simpleRows(inventory.presetRows, CAP.presetRows),
    presetRegistryRows: simpleRows(inventory.presetRegistryRows, CAP.presetRegistryRows),
    skills,
    skillRoots,
    externalCandidates,
    excluded,
    warnings,
    note: '清单已压缩；完整字段用 backup_get_inventory 获取，配置原文用 backup_read_text 精读。',
  });
}

/** 把 manifest 压成恢复 AI 的起步摘要。 */
function summarizeManifest(manifest) {
  if (!isObj(manifest)) {
    return { note: 'Host 未提供 manifest；请先调用 restore_inspect_archive 读取。' };
  }
  const files = toArr(manifest.files ?? manifest.entries);
  const kindCounts = {};
  for (const entry of files) {
    const kind = toStr(entry?.kind) || 'other';
    kindCounts[kind] = (kindCounts[kind] || 0) + 1;
  }
  const pluginsSource = isObj(manifest.plugins) || Array.isArray(manifest.plugins)
    ? manifest.plugins
    : isObj(manifest.inventory)
      ? manifest.inventory.plugins
      : [];
  const plugins = capList(pluginsSource, CAP.plugins).rows.map((item) => compactObject({
    name: toStr(item?.packageName ?? item?.name),
    version: toStr(item?.version),
    kind: toStr(item?.kind),
    spec: clipText(item?.spec, 160),
    linkTarget: clipText(item?.linkTarget, 200),
    source: toStr(item?.source),
  }));
  const excluded = toArr(manifest.excluded ?? manifest.exclusions);

  const notPacked = toArr(manifest.notPacked);
  return compactObject({
    name: clipText(firstStr(manifest.name, manifest.snapshot?.name), 160),
    createdAt: clipText(manifest.createdAt, 40),
    environment: sanitizeEnv(manifest.environment),
    counts: compactObject({
      entries: files.length,
      excluded: excluded.length,
      plugins: toArr(pluginsSource).length,
      notPacked: notPacked.length,
      ...kindCounts,
    }),
    credentialsIncluded: manifest.credentialsIncluded === true ? true : undefined,
    files: capList(files, CAP.files).rows.map((entry) => compactObject({
      kind: toStr(entry?.kind),
      source: clipText(entry?.source, 220),
      archivePath: clipText(entry?.archivePath ?? entry?.archive, 220),
      target: clipText(entry?.target, 240),
      note: clipText(entry?.note, 120),
    })),
    plugins,
    excluded: capList(excluded, 10).rows.map((item) => compactObject({
      path: clipText(item?.path, 200),
      why: clipText(item?.why, 120),
    })),
    note: 'manifest 已压缩；完整条目、sha256、RESTORE.md 用 restore_inspect_archive 读取。',
  });
}

/** 把恢复计划压成摘要；计划很小时直接给原文，便于恢复 AI 精确执行。 */
function summarizeRestorePlan(plan) {
  if (!isObj(plan) || Object.keys(plan).length === 0) return null;

  const items = toArr(plan.items ?? plan.files);
  const steps = toArr(plan.steps).map((step) => {
    if (typeof step === 'string') return clipText(step, 200);
    if (isObj(step)) return clipText(step.title ?? step.detail ?? step.text, 200);
    return clipText(step, 200);
  }).filter(Boolean);

  const summary = compactObject({
    environment: isObj(plan.environment) ? plan.environment : undefined,
    itemsTotal: items.length,
    items: capList(items, 25).rows.map((item) => compactObject({
      kind: toStr(item?.kind),
      source: clipText(item?.source ?? item?.archivePath, 220),
      target: clipText(item?.target, 240),
      note: clipText(item?.note, 120),
    })),
    steps: steps.slice(0, 12),
    restartRequired: typeof plan.restartRequired === 'boolean' ? plan.restartRequired : undefined,
    rollback: clipText(plan.rollback, 160),
    verification: capList(plan.verification, 10).rows.map((item) => clipText(item, 160)).filter(Boolean),
  });

  // 计划本身通常不大：小于阈值时附上原文，避免摘要丢关键细节。
  const raw = stringifyJson(plan);
  if (raw.length <= 2600) summary.rawJson = plan;
  else summary.rawJsonNote = '计划较大，原文请用 restore_inspect_archive 读取 restore-plan.json。';
  return summary;
}

// ---------------------------------------------------------------------------
// 用户提示词渲染
// ---------------------------------------------------------------------------

function buildSnapshotUserPrompt(meta, env, inventorySummary, platformInfo) {
  const lines = [];
  lines.push('请按系统提示词中的 SOP，为下面这个已经配置好的 DSH 环境生成一份可恢复快照。');
  lines.push('');
  lines.push('## 本次快照');
  lines.push(`- 快照名：${clipText(meta.snapshotName, 200) || '（未命名，由 Host 生成）'}`);
  lines.push(`- 快照描述：${clipText(meta.description, 500) || '（无）'}`);
  lines.push('');
  lines.push('## 运行环境（Host 提供；实际路径以工具返回为准）');
  lines.push('```json');
  lines.push(stringifyJson(env));
  lines.push('```');
  lines.push('');
  if (platformInfo) {
    lines.push('## 当前操作系统（Host 提供）');
    lines.push('```json');
    lines.push(stringifyJson(platformInfo));
    lines.push('```');
    lines.push('- 打包策略必须按系统提示词中「当前 osType」对应的 OS 章节执行（linux / windows / other）；');
    lines.push('- RESTORE.md 必须写明本快照的 OS 类型，以及换 OS 恢复时哪些内容不可自动写回（插件代码/原生模块/符号链接/权限）。');
    lines.push('');
  }
  lines.push('## 环境清单摘要（Host 已扫描，已压缩）');
  lines.push('```json');
  lines.push(stringifyJson(inventorySummary));
  lines.push('```');
  lines.push('');
  lines.push('## 开工顺序（必须遵守）');
  lines.push('1. 先调用 `backup_set_progress` 汇报启动进度（progress 0~5），再调用 `backup_get_inventory` 读取完整清单；');
  lines.push('2. 按系统提示词阶段 1~6 执行：读关键配置 → 找并登记外部文件 → `backup_set_restore_plan` → `backup_write_restore_doc` → 最后 `backup_build`；');
  lines.push('3. Host 已自动收集固定配置、凭据文件、扫描到的 Skill 与旧版 preset；你的重点是补「插件本体之外、运行时确实被引用且未被自动收集」的外部数据/脚本/工作目录（判定标准见系统提示词 §5）；');
  lines.push('4. 插件代码本体（profile/node_modules、`$DSH_HOME/dshbox/dshbox-plugins`、DSH 安装目录）一律不加；`backup_add_path` 的 kind 用 plugin-data/skill/mcp/preset/config/external 之一；');
  lines.push('5. `RESTORE.md` 正文必须提醒：压缩包含 `.credentials.yaml` 明文凭据，恢复后需轮换；插件代码本体不在包内，需按 manifest 重装（`dsh plugin --profile <name> add <spec>` / `pnpm install`）；`file:` 本地插件需原始目录存在；恢复后需重启 DSH；');
  lines.push('6. 文档与日志中禁止出现任何密钥/凭据内容。');
  return lines.join('\n');
}

/**
 * 渲染快照 AI 的用户提示词。
 * @param {object} opts
 * @param {string} [opts.snapshotName]
 * @param {string} [opts.description]
 * @param {object} [opts.inventory]  Host scanInventory() 结果
 * @param {object} [opts.config]     运行配置（dshHome/profileDir/backupDir/…；敏感字段会被过滤）
 * @returns {string}
 */
export function renderSnapshotUserPrompt({ snapshotName, description, inventory, config, environment } = {}) {
  const meta = { snapshotName, description };
  const env = sanitizeEnv(config);
  const fullInventory = summarizeInventory(inventory);

  const platformInfo = isObj(environment) ? environment : null;
  let text = buildSnapshotUserPrompt(meta, env, fullInventory, platformInfo);
  if (text.length > MAX_USER_PROMPT_CHARS) {
    // 极端情况下清单过大：退化为「只给数量统计 + 外部候选」，详情让 AI 用工具取。
    const minimal = compactObject({
      generatedAt: fullInventory.generatedAt,
      dshHome: fullInventory.dshHome,
      profileName: fullInventory.profileName,
      profileDir: fullInventory.profileDir,
      counts: fullInventory.counts,
      externalCandidates: fullInventory.externalCandidates,
      warnings: fullInventory.warnings,
      note: '为控制上下文长度，清单明细已省略；请用 backup_get_inventory 获取完整清单，用 backup_read_text 精读配置。',
    });
    text = buildSnapshotUserPrompt(meta, env, minimal, platformInfo);
  }
  return text;
}

function buildRestoreUserPrompt(meta, env, manifestSummary, planSummary, currentSummary, currentPlatform) {
  const lines = [];
  lines.push('请按系统提示词中的 SOP，把下面这份快照安全地恢复到当前 DSH 环境。');
  lines.push('');
  lines.push('## 恢复对象');
  lines.push(`- 快照记录名：${clipText(meta.recordName, 200) || '（未命名）'}`);
  lines.push(`- 快照描述：${clipText(meta.description, 500) || '（无）'}`);
  lines.push(`- 归档文件：${clipText(meta.archivePath, 400) || '（由 Host 提供，见 restore_inspect_archive）'}`);
  lines.push('');
  lines.push('## 快照环境（manifest.environment；仅摘要）');
  lines.push('```json');
  lines.push(stringifyJson(env));
  lines.push('```');
  lines.push('');
  if (currentPlatform) {
    lines.push('## 当前恢复目标系统（Host 提供）');
    lines.push('```json');
    lines.push(stringifyJson(currentPlatform));
    lines.push('```');
    lines.push('- **先调用 `restore_compare`**，读取返回的 `compatibility`（snapshotOs/currentOs/mode/strategy/restrictions/notes），严格按 `compatibility.strategy` 执行；不要自行猜测策略。');
    lines.push('- 四种场景：linux→linux / windows→windows 完整恢复；linux→windows、windows→linux 为兼容恢复（符号链接跳过、registry 插件按来源重装、外部绝对路径 fallback）。');
    lines.push('- 跨 OS 插件代码：默认 `skip-plugin-code` 不写回；若 `restrictions` 含 `plugin-code-js-only`（用户在高级设置启用「迁移纯 JS 插件代码」），Host 会对每个 plugin-code 条目做纯 JS 校验，通过的写回、含原生/平台限制的跳过并记 warnings——按 compare 返回的 restrictions 执行，摘要列出未恢复项。');
    lines.push('');
  }
  lines.push('## manifest 摘要（已压缩；完整条目/校验和用 restore_inspect_archive 读取）');
  lines.push('```json');
  lines.push(stringifyJson(manifestSummary));
  lines.push('```');
  lines.push('');
  lines.push('## 恢复计划摘要（restore-plan.json）');
  lines.push('```json');
  lines.push(stringifyJson(planSummary ?? { note: '未提供恢复计划；请用 restore_inspect_archive 读取，并按 manifest 条目自行规划。' }));
  lines.push('```');
  lines.push('');
  if (currentSummary) {
    lines.push('## 当前环境清单摘要（Host 提供）');
    lines.push('```json');
    lines.push(stringifyJson(currentSummary));
    lines.push('```');
    lines.push('');
  } else {
    lines.push('## 当前环境');
    lines.push('Host 未提供当前环境清单摘要；请用 `restore_compare` 对比快照与当前环境。');
    lines.push('');
  }
  lines.push('## 关键约定');
  lines.push('- 归档文件已由 Host 解包，**不要自己解包**；包内 manifest/RESTORE.md/restore-plan 用 `restore_inspect_archive` 读取。');
  lines.push('- `manifest.entries[].target` 是编码后的目标串（`$DSH_HOME/...`、`$DSH_PROFILE_DIR/...`、`$WORKSPACE:<name>/...` 或绝对路径），`restore_*` 工具会自动解码；`unmapped` 条目不要写回，列入需人工确认。');
  lines.push('- 插件代码本体不在快照包内：恢复配置后通常需要重装依赖；`restore_reinstall_dependencies` **仅在 package.json / lockfile 确实变化时调用一次**（可能耗时且需要网络），完成后仍需重启 DSH。');
  lines.push('- 被覆盖文件的安全备份在本次运行临时目录内，运行结束会清理；可靠的回收方式是「恢复前快照」（Host 已自动创建）。');
  lines.push('');
  lines.push('## 开工顺序（必须遵守）');
  lines.push('1. 先调用 `restore_set_progress` 汇报启动进度（恢复阶段建议从 45 开始），再用 `restore_inspect_archive` 读取 summary / doc / manifest / plan / entries；');
  lines.push('2. 用 `restore_compare`（无参数）对比当前环境：missing/different 需写入、same 跳过、unmapped 报告并列入人工确认；当前多出的文件只报告、不删除；');
  lines.push('3. 分批 `restore_apply_files`（`paths` 传目标绝对路径）：先配置文件，再 Skill / 旧版 preset，再外部数据/脚本，最后凭据文件；每批前后刷进度；');
  lines.push('4. 若 `package.json` / lockfile 与当前不同、依赖确实变化 → 调用一次 `restore_reinstall_dependencies`（可选 timeoutMs；可能耗时且需要网络），完成后仍需重启 DSH；');
  lines.push('5. 校验（`restore_compare` 复核 + 失败项记录）后调用 `restore_finish`；其唯一参数 `summary` 必须写清：恢复了什么、是否需重启 DSH、需人工确认的点、回滚方式（恢复前快照）；');
  lines.push('6. 只恢复 manifest 内条目，不删除当前环境多出的文件，不把密钥/凭据内容写进日志或摘要。');
  return lines.join('\n');
}

/**
 * 渲染恢复 AI 的用户提示词。
 * @param {object} opts
 * @param {string} [opts.recordName]
 * @param {string} [opts.description]
 * @param {string} [opts.archivePath] 解包后的快照根目录
 * @param {object} [opts.manifest]
 * @param {object} [opts.restorePlan]
 * @param {object} [opts.currentInventory]
 * @returns {string}
 */
export function renderRestoreUserPrompt({ recordName, description, archivePath, manifest, restorePlan, currentInventory, environment } = {}) {
  const meta = { recordName, description, archivePath };
  const env = isObj(manifest) && isObj(manifest.environment) ? sanitizeEnv(manifest.environment) : {};
  const manifestSummary = summarizeManifest(manifest);
  const planSummary = summarizeRestorePlan(restorePlan);
  const currentSummary = isObj(currentInventory) ? summarizeInventory(currentInventory) : null;

  const currentPlatform = isObj(environment) ? environment : null;
  let text = buildRestoreUserPrompt(meta, env, manifestSummary, planSummary, currentSummary, currentPlatform);
  if (text.length > MAX_USER_PROMPT_CHARS) {
    // 退化：去掉当前环境清单与文件明细，保留关键路径与开工顺序。
    const minimalManifest = compactObject({
      name: manifestSummary.name,
      createdAt: manifestSummary.createdAt,
      environment: manifestSummary.environment,
      counts: manifestSummary.counts,
      plugins: manifestSummary.plugins,
      note: '为控制上下文长度，文件明细已省略；请用 restore_inspect_archive 读取。',
    });
    text = buildRestoreUserPrompt(meta, env, minimalManifest, planSummary, null, currentPlatform);
  }
  return text;
}
