/**
 * lib/restore-doc.js —— RESTORE.md / INVENTORY.md 渲染器（纯函数：无 fs、无网络、无第三方依赖）。
 *
 * 契约见 docs/MODULE-CONTRACTS.md C 节：
 *   renderRestoreDoc(input)  input = { record, manifest, plan, aiDoc, environment }
 *   renderInventoryDoc(manifest)
 *
 * 设计目标：
 * - 快照 AI 只写「AI 撰写正文」（backup_write_restore_doc），元信息、清单、路径对照表、
 *   固定恢复步骤、校验、回滚、自检清单全部由这里确定性生成，避免 AI 漏项；
 * - 对缺失字段一律容错（真实 manifest 可能来自不同版本的 collect 实现），
 *   结构不完整时仍输出可读、可执行的中文文档；
 * - 对凭据内容零展开：只提示存在与风险，绝不渲染密钥原文。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 配置类条目的 kind；其余 kind 视为「插件本体之外的外部文件」。 */
const CONFIG_KINDS = new Set(['config', 'profile-config', 'config-file']);

const CONFIG_ROLE_LABELS = {
  'profile-package': 'profile 的 package.json：插件依赖与启用的 bundle 顺序',
  'profile-patch': 'profile 补丁层：插件行、MCP 行、Agent Preset 行',
  'profile-root': 'profile 根 cordis.yml（通常为空数组占位）',
  'profile-lock': 'pnpm-lock.yaml：安装版本锁定，重装时使用',
  'profile-workspace': 'pnpm-workspace.yaml：workspace 配置',
  'home-patch': 'DSH_HOME 首页补丁：加载在 profile 之上',
  'plugin-guard': '插件守护/额外补丁文件（dshbox/plugin-guard.json）',
  'legacy-presets': '旧版 Agent Preset 目录（$DSH_HOME/.agent-presets）',
  credentials: '.credentials.yaml：凭据（明文，已打包；恢复后需轮换）',
};

const KIND_LABELS = {
  config: '配置文件',
  credentials: '凭据文件',
  'plugin-data': '插件数据',
  plugin: '本地插件',
  data: '插件数据',
  skill: 'Skill',
  preset: 'Agent Preset',
  mcp: 'MCP Server 文件',
  external: '外部文件',
  'plugin-code': '插件代码本体（已入包）',
  other: '其他文件',
  file: '文件',
};

// ---------------------------------------------------------------------------
// 基础工具（纯函数）
// ---------------------------------------------------------------------------

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

function firstNum(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

/** 压成单行并截断。 */
function clipText(value, max = 200) {
  const text = toStr(value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Markdown 表格单元格：转义竖线、压成单行、截断。 */
function mdCell(value, max = 200) {
  return clipText(value, max).replace(/\|/g, '\\|');
}

/** 行内代码；内容含反引号时用双反引号包裹。 */
function code(value) {
  const text = toStr(value).trim();
  if (!text) return '—';
  return text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** 1024 进制字节格式化（与 archive.formatBytes 行为一致，这里不跨模块依赖）。 */
function fmtBytes(value) {
  const n = firstNum(value);
  if (n === undefined || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = n / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const text = size >= 100 ? size.toFixed(0) : size.toFixed(1);
  return `${text.replace(/\.0$/, '')} ${units[index]}`;
}

/** 压缩率：ratio = 压缩后 / 压缩前（0..1）；若上游给了百分数（>1.5）则按百分数显示。 */
function fmtRatio(value) {
  const n = firstNum(value);
  if (n === undefined || n < 0) return '—';
  const percent = n <= 1.5 ? n * 100 : n;
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** ISO 时间 → `YYYY-MM-DD HH:mm:ss UTC`；解析失败时原样展示。 */
function fmtTime(value) {
  const text = toStr(value).trim();
  if (!text) return '（未记录）';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

function shaShort(value) {
  const text = toStr(value).replace(/\s+/g, '');
  if (!text) return '—';
  return text.length > 16 ? `${text.slice(0, 16)}…` : text;
}

/** osType → 中文展示名（docs 内自包含，不依赖 platform.js）。 */
function osLabelForDoc(value) {
  const t = String(value || '').toLowerCase();
  if (t === 'linux') return 'Linux';
  if (t === 'windows') return 'Windows';
  if (t === 'other') return 'Other';
  return '未知';
}

/** 判断快照 OS 与当前 OS 是否跨系统。 */
function isCrossOs(snapshotOs, currentOs) {
  if (!snapshotOs || !currentOs) return false;
  const s = String(snapshotOs).toLowerCase();
  const c = String(currentOs).toLowerCase();
  if (s === 'unknown' || c === 'unknown') return true; // unknown 保守算跨 OS
  return s !== c;
}

/** 渲染 Markdown 表格；无数据时输出一行「（无）」。 */
function table(headers, rows) {
  const head = `| ${headers.map((item) => mdCell(item, 40)).join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = toArr(rows).length
    ? rows.map((row) => `| ${row.map((cellValue) => mdCell(cellValue, 220)).join(' | ')} |`)
    : [`| ${['（无）', ...headers.slice(1).map(() => '')].join(' | ')} |`];
  return [head, separator, ...body].join('\n');
}

/** AI 正文里的 # / ## 降为 ###，保证拼接在「快照说明」小节之下层级合理。 */
function normalizeAiDoc(value) {
  const text = toStr(value).trim();
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => {
      const match = /^(#{1,6})\s+(.*)$/.exec(line);
      if (!match) return line;
      const level = match[1].length <= 2 ? 3 : match[1].length;
      return `${'#'.repeat(level)} ${match[2]}`;
    })
    .join('\n')
    .trim();
}

/** 判断条目是否属于「插件本体之外的外部文件」（凭据文件单独在安全警告节处理，不算外部文件表）。 */
function isExternalEntry(entry) {
  const kind = toStr(entry?.kind).toLowerCase();
  if (kind === 'credentials') return false;
  return !CONFIG_KINDS.has(kind);
}

/** 纯函数版本的 target 解码：把 $DSH_HOME/… / $DSH_PROFILE_DIR/… / $WORKSPACE:<name>/… 还原成当前机器路径。 */
function decodeTargetPath(encoded, env = {}, workspaces = []) {
  const text = toStr(encoded).trim();
  if (!text) return '';
  const joinPath = (base, rest) => {
    if (!base) return '';
    const clean = String(rest || '').replace(/^[/\\]+/, '');
    if (!clean) return base;
    return `${base.replace(/[/\\]+$/, '')}/${clean}`;
  };
  if (text === '$DSH_PROFILE_DIR' || text.startsWith('$DSH_PROFILE_DIR/')) {
    return joinPath(env.profileDir, text.slice('$DSH_PROFILE_DIR'.length));
  }
  if (text === '$DSH_HOME' || text.startsWith('$DSH_HOME/')) {
    return joinPath(env.dshHome, text.slice('$DSH_HOME'.length));
  }
  if (text.startsWith('$WORKSPACE:')) {
    const tail = text.slice('$WORKSPACE:'.length);
    const slash = tail.indexOf('/');
    const rawName = slash === -1 ? tail : tail.slice(0, slash);
    const rest = slash === -1 ? '' : tail.slice(slash + 1);
    const normalizeName = (value) => toStr(value).replace(/[\s/]+/g, '-');
    const workspace = workspaces.find((item) => normalizeName(item?.name || item?.title || item?.id) === rawName);
    if (!workspace || !workspace.path) return '';
    return joinPath(workspace.path, rest);
  }
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(text) ? text : '';
}

/** 条目记录的目标串（编码形式）。 */
function entryTargetRaw(entry) {
  return firstStr(entry?.target, entry?.source);
}

/** 条目还原到当前机器后的目标路径；无法映射时返回空串。 */
function entryTargetPath(entry, decode) {
  const raw = entryTargetRaw(entry);
  if (!raw) return '';
  const decoded = typeof decode === 'function' ? decode(raw) : '';
  if (decoded) return decoded;
  // 绝对路径原样返回；编码串无法映射时保持空，让调用方提示人工映射。
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(raw) ? raw : '';
}

/** 目标展示：解码成功给路径，否则提示需人工映射。 */
function targetDisplay(entry, decode) {
  const raw = entryTargetRaw(entry);
  if (!raw) return '—';
  const decoded = entryTargetPath(entry, decode);
  if (decoded) return code(decoded);
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(raw)) return code(raw);
  return `需人工映射（${code(raw)}）`;
}

function kindLabel(kind) {
  const key = toStr(kind).toLowerCase();
  return KIND_LABELS[key] || (key ? key : '其他文件');
}

function roleLabel(role) {
  const key = toStr(role);
  return CONFIG_ROLE_LABELS[key] || (key ? key : '配置文件');
}

function planSteps(plan) {
  return toArr(plan?.steps)
    .map((step) => {
      if (typeof step === 'string') return clipText(step, 300);
      if (isObj(step)) return clipText(step.title ?? step.detail ?? step.text ?? step.message, 300);
      return clipText(step, 300);
    })
    .filter(Boolean);
}

function planItemCount(plan) {
  const items = toArr(plan?.items ?? plan?.files);
  return items.length;
}

/** 脱敏：把 YAML/JSON 里形似密钥的值替换掉（只用于展示配置原文时）。 */
function redactSecrets(text) {
  return toStr(text)
    .replace(/^(\s*[-"']?[\w.-]*(?:api[_-]?key|token|secret|password|passwd|authorization|credential|cookie)[\w.-]*["']?\s*:\s*).+$/gim, '$1（已省略）')
    .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization|credential|cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1（已省略）');
}

// ---------------------------------------------------------------------------
// 入口：RESTORE.md
// ---------------------------------------------------------------------------

/**
 * 由结构化数据渲染 RESTORE.md（中文 Markdown）。
 * @param {object} input
 * @param {{name?:string, description?:string, createdAt?:string, kind?:string, file?:string}} [input.record]
 * @param {object} [input.manifest]  快照 manifest.json 内容
 * @param {object} [input.plan]      restore-plan.json 内容
 * @param {string} [input.aiDoc]     快照 AI 撰写的正文（可为空）
 * @param {object} [input.environment] 运行环境覆盖项（dshVersion/dshHome/profileName/profileDir/platform/nodeVersion）
 * @param {string} [input.currentOsType] 当前机器 osType（linux/windows/other），用于生成跨 OS 兼容提示
 * @returns {string} Markdown 文本
 */
export function renderRestoreDoc(input = {}) {
  const source = isObj(input) ? input : {};
  const manifest = isObj(source.manifest) ? source.manifest : {};
  const snapshotMeta = isObj(manifest.snapshot) ? manifest.snapshot : {};
  const record = isObj(source.record) ? source.record : isObj(manifest.record) ? manifest.record : {};
  // collect.js 产出的 manifest 把清单字段平铺在顶层（configFiles/bundles/skills/...），
  // 老契约则可能嵌在 manifest.inventory 里；两种形态都要兼容。
  const inventory = isObj(manifest.inventory)
    ? manifest.inventory
    : isObj(source.inventory)
      ? source.inventory
      : manifest;
  const environment = {
    ...(isObj(manifest.environment) ? manifest.environment : {}),
    ...(isObj(source.environment) ? source.environment : {}),
  };
  const currentOsType = firstStr(source.currentOsType).toLowerCase() || null;
  const plan = isObj(source.plan) ? source.plan : isObj(manifest.plan) ? manifest.plan : {};
  const aiDoc = normalizeAiDoc(source.aiDoc ?? manifest.aiDoc ?? '');

  const files = toArr(manifest.files ?? manifest.entries);
  const excluded = toArr(manifest.excluded ?? manifest.exclusions ?? inventory.excluded);
  const archive = isObj(manifest.archive) ? manifest.archive : {};
  const stats = isObj(manifest.stats) ? manifest.stats : {};
  const workspaces = toArr(manifest.workspaces);

  const name = firstStr(record.name, snapshotMeta.name, manifest.name) || '未命名快照';
  const description = firstStr(record.description, snapshotMeta.description, manifest.description);
  const createdAt = firstStr(record.createdAt, manifest.createdAt);
  const recordKind = firstStr(record.kind, snapshotMeta.kind, manifest.kind);
  const archiveFile = firstStr(record.file, manifest.file, archive.file, manifest.archiveFile);
  const archiveBytes = firstNum(archive.bytes, manifest.bytes, stats.bytes);
  const rawBytes = firstNum(archive.rawBytes, manifest.rawBytes, stats.rawBytes);
  const ratio = firstNum(archive.ratio, manifest.ratio, stats.ratio);

  const dshHome = firstStr(environment.dshHome, inventory.dshHome);
  const profileName = firstStr(environment.profileName, inventory.profileName);
  const profileDir = firstStr(environment.profileDir, inventory.profileDir);
  const dshVersion = firstStr(environment.dshVersion, inventory.dshVersion);
  const platform = firstStr(environment.platform);
  const osType = firstStr(environment.osType, inventory.osType);
  const nodeVersion = firstStr(environment.nodeVersion);
  const arch = firstStr(environment.arch, inventory.arch);
  const osRelease = firstStr(environment.osRelease, inventory.osRelease);

  const profile = profileName || '<profile>';
  const profilePath = profileDir || `${dshHome || '$DSH_HOME'}/profiles/${profile}`;
  const dshHomePath = dshHome || '$DSH_HOME';

  const decodeEnv = { dshHome, profileDir, profileName };
  const decode = (encoded) => decodeTargetPath(encoded, decodeEnv, workspaces);

  const configFiles = toArr(manifest.configFiles ?? inventory.configFiles);
  const bundles = toArr(manifest.bundles ?? inventory.bundles);
  const plugins = toArr(manifest.plugins ?? inventory.plugins);
  const mcpRows = toArr(manifest.mcpRows ?? inventory.mcpRows);
  const presetRows = toArr(manifest.presetRows ?? inventory.presetRows);
  const presetRegistryRows = toArr(manifest.presetRegistryRows ?? inventory.presetRegistryRows);
  const notPacked = toArr(manifest.notPacked);
  const credentialsIncluded = manifest.credentialsIncluded === true;
  const packedPlugins = plugins.filter((plugin) => plugin && plugin.packed === true);
  const pluginCodeEntries = files.filter((entry) => toStr(entry?.kind).toLowerCase() === 'plugin-code');
  const pluginCodeIncluded = packedPlugins.length > 0 || pluginCodeEntries.length > 0;
  const snapshotPolicy = manifest.snapshotPolicy && typeof manifest.snapshotPolicy === 'object' ? manifest.snapshotPolicy : {};
  const packPolicyMode = toStr(snapshotPolicy.packPluginCode) || (pluginCodeIncluded ? 'local-only' : 'none');
  const externalFiles = files.filter((entry) => isExternalEntry(entry) && toStr(entry?.kind).toLowerCase() !== 'plugin-code');
  const pluginCodeFiles = files.filter((entry) => toStr(entry?.kind).toLowerCase() === 'plugin-code');
  const configEntries = files.filter((entry) => !isExternalEntry(entry) && toStr(entry?.kind).toLowerCase() !== 'credentials');

  // 凭据文件（只出现路径，不展开内容）。
  const credentialPaths = new Set();
  const credentialRe = /(\.credentials\.yaml|credentials|\.key$|id_rsa|id_ed25519|\.pem$|\.env(\.|$))/i;
  for (const item of configFiles) {
    const path = toStr(item?.path);
    if (path && credentialRe.test(path)) credentialPaths.add(path);
  }
  for (const item of files) {
    const kind = toStr(item?.kind).toLowerCase();
    if (kind === 'credentials') {
      const path = firstStr(item?.source, decode(item?.target), item?.target);
      if (path) credentialPaths.add(path);
      continue;
    }
    const path = firstStr(item?.target, item?.source);
    if (path && credentialRe.test(path)) credentialPaths.add(path);
  }
  if (credentialsIncluded && credentialPaths.size === 0) credentialPaths.add(`${dshHomePath}/.credentials.yaml`);

  const out = [];
  const push = (...lines) => out.push(...lines);

  // -------------------------------------------------------------------------
  // 标题 + 顶部安全警告
  // -------------------------------------------------------------------------
  push('# DSH 环境恢复说明（RESTORE.md）', '');
  push('> 本文件由 `dsh-backup-all` 在生成快照时自动渲染：AI 撰写的正文与 Host 生成的机器清单在此拼装。');
  push('> 机器可读信息见同包 `manifest.json`，结构化恢复计划见 `restore-plan.json`，环境清单摘要见 `INVENTORY.md`。');
  push('> **恢复前请先通读「2. 安全警告与凭据处理」与「13. 失败回滚」两节。**', '');
  if (credentialsIncluded) {
    push('> ⚠️ **安全警告：本快照包含凭据文件（如 `$DSH_HOME/.credentials.yaml`），且以明文存放在压缩包内。**');
    push('> 请妥善保管快照压缩包与解包目录，不要上传/外发给他人；恢复完成后请立即轮换相关密钥与凭据。详见「2. 安全警告与凭据处理」。', '');
  } else {
    push('> ℹ️ 本快照**未包含**凭据文件（生成时设置了「不打包凭据」）；恢复后需要重新填写 API Key / 账号凭据。');
    push('> 但仍请妥善保管压缩包：其中的配置文件与插件数据仍可能含敏感信息。详见「2. 安全警告与凭据处理」。', '');
  }
  if (pluginCodeIncluded) {
    push('> 📦 本快照**包含插件代码本体**（' + packedPlugins.length + ' 个已打包插件）：恢复时需要把代码解出到对应目录并重新链接/安装，详见「9. 插件清单与重装命令」。', '');
  }

  // -------------------------------------------------------------------------
  // 1. 快照元信息
  // -------------------------------------------------------------------------
  const kindLabelText = recordKind === 'pre-restore' ? '恢复前快照（pre-restore）' : recordKind === 'snapshot' ? '普通快照（snapshot）' : recordKind || '快照';
  push('## 1. 快照元信息', '');
  push(table(
    ['项目', '值'],
    [
      ['快照名', mdCell(name, 160)],
      ['快照描述', description ? mdCell(description, 300) : '（无）'],
      ['快照类型', kindLabelText],
      ['创建时间', fmtTime(createdAt)],
      ['快照文件', archiveFile ? code(archiveFile) : '（打包完成后由记录列表给出）'],
      ['压缩后大小', fmtBytes(archiveBytes)],
      ['原始大小', fmtBytes(rawBytes)],
      ['压缩率', fmtRatio(ratio)],
      ['文件条目数', String(files.length)],
      ['排除项数', String(excluded.length)],
      ['压缩格式', '`tar` + Brotli（Q11，Node 内建 zlib），扩展名 `.backup.tar.br`'],
      ['生成工具', '`dsh-backup-all`'],
    ],
  ), '');

  // -------------------------------------------------------------------------
  // 2. 安全警告与凭据处理
  // -------------------------------------------------------------------------
  push('## 2. 安全警告与凭据处理', '');
  push(`本快照的打包决策：插件代码本体策略 = \`${packPolicyMode}\`（${pluginCodeIncluded ? '部分或全部插件代码已入包' : '插件代码未入包'}）；凭据文件 = ${credentialsIncluded ? '**已入包（明文）**' : '未入包'}。`, '');
  if (credentialsIncluded) {
    push('凭据文件说明：', '');
  push('- 凭据以**明文**存放在压缩包内（如 `$DSH_HOME/.credentials.yaml`），解包后同样是明文；');
  push('- 不要上传到网盘/代码仓库/聊天工具，不要发给不可信的人；');
  push('- 恢复完成后请**立即轮换**相关 API Key、token、cookie、密码；');
  push('- 若本快照会被长期归档，建议先创建不含凭据的副本，或对压缩包做加密存储；');
  push('- 本文件与 `manifest.json` 只记录凭据文件路径，**不包含任何凭据内容**。', '');
  if (credentialPaths.size > 0) {
    push('快照中可能包含的凭据文件（仅列路径）：', '');
    push(table(
      ['凭据文件路径', '说明'],
      [...credentialPaths].sort().map((path) => [code(path), '明文；恢复后请轮换，不要外发']),
    ), '');
  } else {
    push('清单未显式记录凭据文件；若快照内存在 `.credentials.yaml` 等文件，同样按明文处理。', '');
  }
  } else {
    push('本快照未包含凭据文件（设置了「不打包凭据」）：');
    push('');
  }

  if (!credentialsIncluded) {
    const excludedByPolicy = snapshotPolicy.excludeCredentials === true;
    push('- 本快照**不含凭据文件**（' + (excludedByPolicy ? '快照时设置了「不打包凭据」' : '快照生成时本机就没有凭据文件') + '）：恢复后请重新填写模型/插件 API Key、账号登录等凭据；');
    push('- 若目标机已有自己的凭据文件，恢复流程**不会覆盖**它（清单里没有该条目）；');
    push('- `RESTORE.md` / `manifest.json` 只记录凭据文件路径，不包含任何凭据内容。', '');
  }

  // -------------------------------------------------------------------------
  // 2b. 跨 OS 兼容恢复（快照 OS ≠ 当前 OS 时显著标注）
  // -------------------------------------------------------------------------
  const _crossOs = isCrossOs(osType, currentOsType);
  // RESTORE.md 在快照机生成：即使当前与快照同 OS，也要给出「换 OS 恢复」的兼容说明
  if (_crossOs || osType === 'unknown' || osType === 'linux' || osType === 'windows' || osType === 'other') {
    push('## 2b. ⚠️ 跨操作系统兼容恢复（如需换 OS 使用本快照）', '');
    const snapshotLabel = osLabelForDoc(osType);
    const currentLabel = currentOsType ? osLabelForDoc(currentOsType) : '当前';
    if (_crossOs) {
      push(`> **警告**：本快照生成于 **${snapshotLabel}**，当前恢复目标为 **${currentLabel}**。`, '');
    } else {
      push(`> 本快照生成于 **${snapshotLabel}**；如果在另一操作系统（如 Windows↔Linux）上恢复，以下内容不会自动写回。同 OS 恢复可忽略本节。`, '');
    }
    push('> 以下内容在跨 OS 恢复时将**不自动写回**，需人工迁移处理：', '');
    push('');
    push('| 不可自动恢复项 | 说明 | 人工处理建议 |');
    push('| --- | --- | --- |');
    push('| 插件代码本体（plugin-code 条目） | Linux 插件代码/原生模块不可直接用于 Windows | 在目标 OS 重新安装插件：`dsh plugin --profile <name> add <spec>`；本地插件需在目标 OS 重新获取源码 |');
    push('| 符号链接（symlink） | 跨 OS 的符号链接目标路径不同、权限模型不同 | 解包时自动跳过；需人工重建等价 junction/symlink（Windows：`mklink` 或 `New-Item -ItemType SymbolicLink`） |');
    push('| 外部绝对路径 | Linux `/root/...` 在 Windows 无对应路径 | Host 会自动 fallback 到 `<DSH_HOME>/restore-external/<文件名>`；恢复后需人工移动到正确位置 |');
    push('| 文件权限（0600） | Windows 不支持 POSIX 权限 | Windows 上按 NTFS ACL 另行设置（见下文权限提示） |');
    push('| registry 插件 | 不同 OS 的 registry 安装来源可能不同 | 按 `manifest.plugins[].source` 在目标 OS 重装 |');
    if (pluginCodeIncluded) {
      push(`| 已入包插件代码（${packedPlugins.length} 个） | 跨 OS 已自动跳过（` + '`skip-plugin-code`' + ` 限制） | 在目标 OS 重新获取源码并 ` + '`dsh plugin add file:<目录>`' + ` |`);
    }
    push(`| Windows link/file 依赖 | profile package.json 里的 Windows 绝对路径依赖（如 \`link:C:/...\`）在 Linux 不可用 | Host 会移除；请在 Linux 重新获取源码/用 registry 重装 |`);
    push(`| 命令壳差异 | Windows 上 dsh.cmd/pnpm.cmd；Linux 上 dsh/pnpm | 按目标系统执行：Linux 用 POSIX 命令（\`cd <profile> && dsh plugin --profile <name> install\`），Windows 用 PowerShell |`);
    push('');

    if (!currentOsType) {
      push('> ℹ️ 当前操作系统类型未提供（`currentOsType` 为空）；以上按最保守的跨 OS 策略生成。如实际为同 OS 恢复，请忽略本节。', '');
    }
    push('');
  }

  // 平台适配：Windows 快照的权限/命令/Junction 提示
  const _isWinSnapshot = osType === 'windows';

  // -------------------------------------------------------------------------
  // 3. 环境要求
  // -------------------------------------------------------------------------
  const envRows = [
    ['目标 DSH 版本', dshVersion ? code(dshVersion) : '（未记录；建议使用与快照相同或兼容的 DSH 版本）'],
    ['profile 名', code(profile)],
    ['DSH_HOME', code(dshHomePath)],
    ['profile 目录', code(profilePath)],
    ['操作系统', osType ? osLabelForDoc(osType) + (arch ? ` (${arch})` : '') : platform || '（未记录）'],
    ['OS 版本', osRelease || platform || '（未记录）'],
    ['Node 版本', nodeVersion || '（未记录）'],
    ['磁盘空间', rawBytes !== undefined ? `至少 ${fmtBytes(rawBytes)} 可用空间（解包 + 写回）` : '（未记录；按快照原始大小预留）'],
  ];
  push('## 3. 环境要求', '');
  push(table(['项目', '要求 / 值'], envRows), '');
  push('- 本快照**不包含 DSH 安装目录本体**（如 `/opt/dshapp/runtime`），目标机需先安装 DSH；建议与快照同版本或兼容版本。');
  push(`- 若目标机 profile 名不同（本快照为 ${code(profile)}）：把配置放到目标 profile 目录，并把下文命令中的 \`--profile ${profile}\` 换成实际名称。`);
  push('- DSH 版本不一致时，补丁行里的插件名/配置字段可能不兼容：恢复后如插件加载失败，按目标版本的字段手工调整。', '');

  // -------------------------------------------------------------------------
  // 4. 快照内容边界
  // -------------------------------------------------------------------------
  push('## 4. 快照内容边界（包含 / 不包含）', '');
  push('### 4.1 包里包含', '');
  push('- profile 配置层：`package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`；');
  push(`- \`${dshHomePath}/cordis.patch.yml\`（存在时）；`);
  push(`- \`${dshHomePath}/dshbox/plugin-guard.json\`（存在时）；`);
  if (credentialsIncluded) {
    push(`- \`${dshHomePath}/.credentials.yaml\` 凭据文件（**明文**，见「2. 安全警告与凭据处理」）；`);
  }
  if (pluginCodeIncluded) {
    push(`- **插件代码本体**（${packedPlugins.length} 个插件；策略 \`${packPolicyMode}\`）：${packedPlugins.map((plugin) => '`' + toStr(plugin?.name) + '`').join('、') || '见 manifest.entries 的 plugin-code 条目'}；`);
  }
  push('- Skill 文件（用户级 `$DSH_HOME/skills`、`~/.agents/skills`，以及实际使用的工作区 Skill 根）；');
  push(`- 旧版 Agent Preset：\`${dshHomePath}/.agent-presets/<id>/\`（存在时）；`);
  push('- 插件本体之外的**外部文件**：插件数据目录、MCP Server 脚本/工作目录、自定义 Skill 根、Preset 源文件等（见「11. 外部文件对照表」）。', '');
  push('### 4.2 包里不包含（需重装或手工处理）', '');
  if (pluginCodeIncluded) {
    const notPackedPlugins = plugins.filter((plugin) => plugin && plugin.packed !== true);
    push('- **已入包插件代码**：见「9」中 `代码入包` 列；其余插件（可再下载）代码未入包，按「9」的 spec 重装即可；');
    if (notPackedPlugins.length > 0) {
      push('- 未入包的插件：' + notPackedPlugins.map((plugin) => '`' + toStr(plugin?.name) + '`').join('、') + '（可再下载，用 `dsh plugin add <spec>` 重装）；');
    }
  } else {
    push('- **插件 / registry 包代码本体**：profile `node_modules` 下的实体包、`file:` 本地插件源码目录、`$DSH_HOME/dshbox/dshbox-plugins/<name>/plugin` 等，均不在包内；包里只有 `manifest` 记录的插件元数据（名称/版本/source/spec），恢复时按「9. 插件清单与重装命令」重装；');
    push('- `file:` 本地插件：恢复后要求**原始源码目录仍然存在**；若目标机没有该目录，需按 manifest 记录的 source 重新放置/链接，再执行 `dsh plugin --profile <name> add file:<目录>`；');
  }
  push('- DSH 安装目录本体（如 `/opt/dshapp/runtime`）：需在目标机自行安装 DSH；');
  push('- DSH 会话、存储、缓存、日志、临时文件：不恢复；');
  push('- 大文件（模型权重、下载缓存等）：若快照 AI 在正文中标注了「未打包」，需手工安装/下载。', '');
  if (notPacked.length > 0) {
    push('清单记录的未打包项（只入元数据，不在包内）：', '');
    push(table(
      ['类型', '路径', '原因'],
      notPacked.slice(0, 100).map((item) => [
        toStr(item?.kind) || '—',
        code(item?.path),
        mdCell(firstStr(item?.why), 200) || '—',
      ]),
    ), '');
  }

  // -------------------------------------------------------------------------
  // 5. 快照说明（AI 撰写）+ 恢复计划摘要
  // -------------------------------------------------------------------------
  push('## 5. 快照说明（AI 撰写）', '');
  if (aiDoc) {
    push('> 以下内容由快照 AI 撰写，Host 原样拼装（标题层级已自动降级以适配本文档结构）。', '');
    push(aiDoc, '');
  } else {
    push('快照 AI 未撰写额外恢复说明（`aiDoc` 为空）。请以本文件下方的机器清单与固定恢复步骤为准；');
    push('如需查看快照包含的完整条目与校验和，请阅读同目录的 `INVENTORY.md` 或 `manifest.json`。', '');
  }

  const steps = planSteps(plan);
  const itemCount = planItemCount(plan);
  if (steps.length > 0 || itemCount > 0 || isObj(plan) && Object.keys(plan).length > 0) {
    push('### 5.1 结构化恢复计划摘要（`restore-plan.json`）', '');
    push(`- 计划条目数：${itemCount}`);
    push(`- 重启要求：${plan.restartRequired === true ? '需要重启 DSH' : plan.restartRequired === false ? '未要求重启（仍建议重启使插件生效）' : '未注明（建议重启 DSH）'}`);
    if (steps.length > 0) {
      push('');
      push('计划步骤：');
      steps.forEach((step, index) => push(`${index + 1}. ${mdCell(step, 220)}`));
    }
    push('');
    push('完整 JSON 见同包 `restore-plan.json`；恢复 AI 会按计划执行。', '');
  }

  // -------------------------------------------------------------------------
  // 6. 恢复步骤
  // -------------------------------------------------------------------------
  push('## 6. 恢复步骤', '');
  push('以下为**手工恢复**流程；使用 `dsh-backup-all` 的「恢复」功能时，Host 会自动解包并按条目逐条写回，AI 恢复助手会按 `restore-plan.json` 执行，最后仍需按「6.6 重启 DSH」操作。', '');

  push('### 6.1 解包快照', '');
  push('快照是 `tar` + Brotli 压缩（`.backup.tar.br`），系统 `tar` 不支持 Brotli，需先用 Node 解一层：', '');
  push('```bash');
  push('# 1) 准备目录');
  push('mkdir -p ~/dsh-restore');
  push('# 2) Brotli 解压出 tar（Node 内建 zlib）');
  push(`node -e "const {readFileSync,writeFileSync}=require('node:fs');const {brotliDecompressSync}=require('node:zlib');writeFileSync('/tmp/dsh-restore.tar',brotliDecompressSync(readFileSync('${archiveFile || '<快照文件路径>'}')));"`);
  push('# 3) 解出 tar');
  push('tar -xf /tmp/dsh-restore.tar -C ~/dsh-restore');
  push('ls ~/dsh-restore   # 应看到 manifest.json / RESTORE.md / restore-plan.json / INVENTORY.md / files/');
  push('```', '');

  if (_isWinSnapshot) {
    push('**Windows（PowerShell）**：', '');
    push('```powershell');
    push('# 1) 准备目录');
    push('New-Item -ItemType Directory -Force -Path ~/dsh-restore');
    push('# 2) Brotli 解压出 tar（Node 内建 zlib）');
    push(`node -e "const {readFileSync,writeFileSync}=require('node:fs');const {brotliDecompressSync}=require('node:zlib');writeFileSync('$env:TEMP\\dsh-restore.tar',brotliDecompressSync(readFileSync('${archiveFile || '<快照文件路径>'}')));"`);
    push('# 3) 解出 tar（Windows 10+ 内置 tar 命令）');
    push('tar -xf $env:TEMP\\dsh-restore.tar -C ~/dsh-restore');
    push('ls ~/dsh-restore');
    push('```', '');
    push('> ℹ️ Windows 上 `dsh` 命令一般为 `dsh.cmd`；PowerShell 中使用 `& dsh ...` 或 `dsh.cmd ...`。');
    push('');
  }

  push('### 6.2 恢复配置文件', '');
  push('对照「8. 配置文件说明」与「7. 路径对照表」，把 `files/...` 中的配置复制到目标路径（用表中「当前机器路径」列；`manifest.entries[].target` 里可能是 `$DSH_HOME/...` 这类编码串，需按当前机器还原）：', '');
  push('```bash');
  push(`cp -a ~/dsh-restore/files/<快照内路径> ${profilePath}/`);
  push('```', '');
  push('- 先备份当前配置：`cp -a <目标文件> <目标文件>.bak`（使用「AI 恢复」时 Host 会把被覆盖文件临时备份到本次运行目录的 `.restore-safety/`，但运行结束会清理，不要依赖它长期回滚）；');
  push('- `package.json` 与 `cordis.patch.yml` 决定「装哪些插件、启用哪些 bundle、MCP/Preset 行是什么」，必须与快照一致；');
  push(`- 若快照里没有 \`${dshHomePath}/cordis.patch.yml\`（快照时不存在），而目标机存在该文件 → **不要删除**，记录差异并确认不会覆盖快照内的行；`);
  push('- `.credentials.yaml` 等凭据文件按「2」处理，恢复后轮换；');
  push('- **若本插件（dsh-backup-all）自身在快照生成时尚未安装**：写回 profile `package.json` 时 Host 会自动补回本插件的依赖与 `dsh.profile.bundles` 选择（Loader 行由 bundle patch 提供；`cordis.patch.yml` 按快照原样恢复），避免恢复过程中把正在执行恢复的插件卸载。如确实想移除本插件，请在恢复完成后手动删除依赖/选择并重启 DSH；');
  push('- 保持运行用户对文件可读写，不要改坏属主/权限。', '');
  if (_isWinSnapshot) {
    push('');
    push('**Windows 权限提示**：', '');
    push('- 快照内 POSIX 权限（如 `0600`）在 Windows 上无直接等效项；恢复后按 NTFS ACL 另行设置；');
    push('- 凭据等敏感文件建议限制为当前用户只读（右键 → 属性 → 安全 → 仅允许当前用户）；');
    push('- `dsh.cmd` 需在命令行中以完整名称调用（不要在 PowerShell 里直接用 `dsh`，用 `dsh.cmd` 或 `& dsh`）。');
  }

  push('### 6.3 恢复外部文件', '');
  push('插件本体之外的外部文件（本地插件数据、Skill、MCP 脚本/工作目录、Preset 源文件）按「11. 外部文件对照表」的当前机器目标路径放回：', '');
  push('```bash');
  push('mkdir -p <目标父目录> && cp -a ~/dsh-restore/files/<快照内路径> <目标路径>');
  push('```', '');
  push('- 目录保持原样复制（`cp -a` 保留权限与 mtime），不要只复制部分文件；');
  push('- 符号链接按原指向重建（先确认目标机上的链接目标路径也存在）；');
  push('- 若目标机 workspace 路径与快照不同，把 `target` 映射到新路径后记录在恢复日志中；');
  push('- 覆盖前先备份目标机上已有文件。', '');
  if (_isWinSnapshot) {
    push('');
    push('**Windows junction / symlink 说明**：', '');
    push('- 快照中的符号链接在 Windows 上可能创建失败（需管理员权限或开发者模式）；Host 解包策略为 `auto`（失败时降级：复制目标内容，无法复制则跳过）；');
    push('- 手工恢复时用 `mklink`（cmd）或 `New-Item -ItemType SymbolicLink`（PowerShell）重建；');
    push('- junction（目录链接）用 `mklink /J <link> <target>` 创建，无需管理员权限。');
  }

  push('### 6.4 恢复插件依赖与重装', '');
  if (pluginCodeIncluded) {
    push('本快照**包含部分/全部插件代码本体**（标记为 `plugin-code` 的条目）。恢复顺序：', '');
    push('1. 先把 `plugin-code` 条目按「7. 路径对照表」解出到各自的 `codeTarget`（Host 自动重映射；若目标机路径变了看条目 `remap` 结果）；');
    push('2. 再对每个已入包插件执行 `dsh plugin --profile <name> add file:<解出的目录>` 重新链接/安装；');
    push('3. 其余可再下载插件按「9」的 spec 重装；');
    push('4. 最后统一执行依赖安装（见下）。', '');
  } else {
    push('插件代码本体不在快照包内，需要按「9. 插件清单与重装命令」重装：', '');
  }
  push('```bash');
  push(`cd ${profilePath} && dsh plugin --profile ${profile} install   # 优先用 DSH 自带安装器复现依赖`);
  push(`cd ${profilePath} && pnpm install --frozen-lockfile            # 安装器不可用/失败时，按 lockfile 复现`);
  push(`dsh plugin --profile ${profile} list                          # 核对已安装插件与快照清单一致`);
  push('```', '');
  push('- 缺插件时按「9」的 `恢复方式` 列逐项安装：`dsh plugin --profile <name> add <spec>`；');
  push('- `file:` 本地插件：先确保原始源码目录存在（不存在则按 manifest 的 source 重新放置/链接），再 `dsh plugin --profile <name> add file:<目录>`；');
  push('- **依赖安装是恢复的固定收尾动作**：恢复 AI 必须调用一次 `restore_reinstall_dependencies`（内部执行 `dsh plugin --profile <name> install`，失败回退 `pnpm install`）；随后 Host 还会在 AI 流程结束后**机械性强制执行一次**同样的安装（幂等，双保险）。');
  push('- 两处安装都失败时才需要人工按上面的命令处理，并写进恢复摘要；');
  push('- 依赖重装可能耗时且需要网络，完成后仍需重启 DSH。', '');

  push('### 6.5 校验', '');
  push('按「12. 校验方式」逐项检查（文件落位、哈希、JSON 可解析、插件列表、启动日志）。', '');

  push('### 6.6 重启 DSH（使配置生效）', '');
  push('- **重启 DSH 宿主进程**（关闭并重新启动 DSH 服务 / 重新打开 DSH Web 应用）；');
  push('- **只刷新浏览器页面不够**：Host 插件组合与补丁 YAML 只在 DSH 启动时加载；');
  push('- 重启后按「14. 恢复后自检清单」逐项确认：插件列表、Skill、MCP 连接、Agent Preset。', '');

  // -------------------------------------------------------------------------
  // 7. 路径对照表
  // -------------------------------------------------------------------------
  push('## 7. 路径对照表（快照内 → 恢复目标）', '');
  push('`快照内路径` 相对解包目录；`恢复目标（记录值）` 是 manifest 记录的目标串（可能是 `$DSH_HOME/...` 这类可迁移编码），`当前机器路径` 是按本文件「3. 环境要求」还原后的绝对路径。完整条目、sha256 与备注见 `manifest.json`。', '');
  push('');
  push('**跨机器自动重映射规则**（恢复 AI 的 `restore_compare` / `restore_apply_files` 会自动执行）：', '');
  push('- `$DSH_HOME/…`、`$DSH_PROFILE_DIR/…`、`$WORKSPACE:<name>/…` → 按目标机当前环境自动展开；`$WORKSPACE` 名字不同时会按「旧名 → 旧目录名 → 当前 workspace」再匹配；');
  push('- 外部绝对路径：目标机原路径存在则原样使用；不存在则按旧 `profileDir` / `dshHome` / `homeDir` / workspace 前缀重映射；仍失败则落到 `<目标机 DSH_HOME>/restore-external/<文件名>`；');
  push('- 无法映射的条目不会写回，恢复摘要中会列出「需人工确认」；所有重映射/fallback 项都会在 `remap` 字段与恢复摘要中给出原路径对照。', '');
  if (files.length > 0) {
    const MAX_ROWS = 200;
    const rows = files.slice(0, MAX_ROWS).map((entry, index) => [
      String(index + 1),
      kindLabel(entry?.kind),
      code(firstStr(entry?.archivePath, entry?.archive, entry?.path) || '（未记录）'),
      code(entryTargetRaw(entry) || '（未记录）'),
      targetDisplay(entry, decode),
      shaShort(entry?.sha256),
      mdCell(firstStr(entry?.note, entry?.why), 160) || '—',
    ]);
    push(table(['序号', '类型', '快照内路径', '恢复目标（记录值）', '当前机器路径', 'sha256（前 16 位）', '备注'], rows), '');
    if (files.length > MAX_ROWS) {
      push(`> 条目较多，本表只列前 ${MAX_ROWS} 条；其余 ${files.length - MAX_ROWS} 条见 \`manifest.json\`。`, '');
    }
  } else {
    push('manifest 中未记录文件条目（可能由 Host 自动收集、未回填明细）。请使用 `restore_inspect_archive` 查看归档条目，或直接按「8. 配置文件说明」逐个恢复。', '');
  }

  // -------------------------------------------------------------------------
  // 8. 配置文件说明
  // -------------------------------------------------------------------------
  push('## 8. 配置文件说明', '');
  const fallbackConfigRows = [
    [`${profilePath}/package.json`, 'profile-package'],
    [`${profilePath}/cordis.patch.yml`, 'profile-patch'],
    [`${profilePath}/cordis.yml`, 'profile-root'],
    [`${profilePath}/pnpm-lock.yaml`, 'profile-lock'],
    [`${profilePath}/pnpm-workspace.yaml`, 'profile-workspace'],
    [`${dshHomePath}/cordis.patch.yml`, 'home-patch'],
    [`${dshHomePath}/dshbox/plugin-guard.json`, 'plugin-guard'],
    [`${dshHomePath}/.credentials.yaml`, 'credentials'],
  ].map(([path, role]) => ({ path, role, exists: undefined, bytes: undefined, sha256: undefined }));

  const configRows = configFiles.length > 0 ? [...configFiles] : fallbackConfigRows;
  if (credentialsIncluded && !configRows.some((item) => credentialRe.test(toStr(item?.path)))) {
    configRows.push({ path: `${dshHomePath}/.credentials.yaml`, role: 'credentials', exists: true, bytes: undefined, sha256: undefined });
  }
  push(table(
    ['文件路径', '作用 / 角色', '快照时是否存在', '大小', 'sha256（前 16 位）'],
    configRows.map((item) => [
      code(item?.path),
      mdCell(roleLabel(item?.role), 200),
      item?.exists === false ? '不存在' : item?.exists === true ? '存在' : '（未记录）',
      fmtBytes(item?.bytes),
      shaShort(item?.sha256),
    ]),
  ), '');
  if (configFiles.length === 0) {
    push('> 清单未回填 `configFiles` 明细，上表按标准 profile 配置结构列出；请以 `manifest.json` 为准。', '');
  }
  push('字段说明：', '');
  for (const [role, label] of Object.entries(CONFIG_ROLE_LABELS)) {
    push(`- ${code(role)}：${label}`);
  }
  push('- 「不存在」条目：快照时该文件不存在，恢复时可跳过，不要凭空创建空文件；');
  push('- `node_modules` 不在配置清单内，由「6.4」的依赖重装负责；', '');

  // -------------------------------------------------------------------------
  // 9. 插件清单与重装命令
  // -------------------------------------------------------------------------
  push('## 9. 插件清单与重装命令', '');
  if (pluginCodeIncluded) {
    push(`**插件代码本体策略 \`${packPolicyMode}\`**：本快照已打包 ${packedPlugins.length} 个插件的代码（见下表「代码入包」列与 manifest.plugins[].codeTarget）；其余可再下载插件只记元数据。恢复顺序：先恢复配置文件 → 解出已入包插件代码并重新链接 → 按 spec 重装其余插件 → 装依赖。`, '');
  } else {
    push('**插件代码本体不在快照包内**：本节是恢复所需的包元数据（来自 `manifest` / 环境扫描）。恢复顺序：先恢复 `package.json` / `pnpm-lock.yaml`，再按下文命令重装。', '');
  }

  push('### 9.1 已启用 bundle（随 DSH 安装 / profile 安装）', '');
  const bundleRows = bundles.map((item) => [
    toStr(item?.name),
    toStr(item?.version) || '—',
    toStr(item?.availability) || '—',
    item?.enabled === false ? '否' : '是',
    toArr(item?.rows).map((row) => toStr(row?.rowId ?? row)).filter(Boolean).join(', ') || '—',
    bundleRestoreHint(item, profile),
  ]);
  push(table(['Bundle', '版本', '可用性', '已启用', '包含插件行', '恢复方式'], bundleRows), '');
  if (bundles.length === 0) {
    push('> 清单未记录 bundle（Host 的 `pluginManager.listBundles()` 可能不可用）。请以 `manifest.json` / 恢复后的 `package.json` 为准。', '');
  }

  push('### 9.2 profile 依赖与本地插件（元数据）', '');
  const pluginRows = plugins.map((item) => [
    toStr(item?.packageName ?? item?.name),
    toStr(item?.version) || '—',
    toStr(item?.kind) || '—',
    clipText(firstStr(item?.spec, item?.source), 80) || '—',
    firstStr(item?.linkTarget) ? code(item.linkTarget) : '—',
    item?.packed === true ? '是' : '否',
    item?.packed === true && firstStr(item?.codeTarget) ? code(item.codeTarget) : '—',
    pluginRestoreHint(item, profile),
  ]);
  push(table(['包名', '版本', '类型', '安装来源 / spec', '链接目标（file:）', '代码入包', '代码恢复目标', '恢复方式'], pluginRows), '');
  if (plugins.length === 0) {
    push('> 清单未记录插件元数据；请以恢复后的 `package.json` 与 `dsh plugin --profile <name> list` 为准。', '');
  }

  push('### 9.3 可直接执行的命令', '');
  const commands = new Set();
  commands.add(`cd ${profilePath} && dsh plugin --profile ${profile} install   # 优先用 DSH 自带安装器；失败再用下面的 pnpm`);
  commands.add(`cd ${profilePath} && pnpm install --frozen-lockfile`);
  for (const item of bundles) {
    const availability = toStr(item?.availability);
    if (item?.external === true) continue; // 本地 bundle 由 9.2 的插件循环给 file:/codeTarget 命令
    if (availability === 'profile' || availability === 'missing') {
      const spec = bundleSpec(item);
      if (spec) commands.add(`dsh plugin --profile ${profile} add ${spec}`);
    }
  }
  for (const item of plugins) {
    if (item?.packed === true && firstStr(item?.codeTarget)) {
      commands.add(`# 已入包插件代码（${toStr(item?.packageName ?? item?.name)}）：先按 6.4 解出到 ${item.codeTarget}，再：\ndsh plugin --profile ${profile} add file:"<解出后的目录>"`);
      continue;
    }
    const linkTarget = firstStr(item?.linkTarget);
    if (linkTarget) {
      commands.add(`# file: 本地插件（先确保源码目录存在）\ndsh plugin --profile ${profile} add file:${linkTarget}`);
    } else {
      const spec = pluginSpec(item);
      if (spec) commands.add(`dsh plugin --profile ${profile} add ${spec}`);
    }
  }
  commands.add(`dsh plugin --profile ${profile} list`);
  push('```bash');
  for (const command of commands) push(command);
  push('```', '');
  if (bundles.length === 0 && plugins.length === 0) {
    push('> 未从清单拿到插件元数据：请人工对照快照生成机的 `package.json` 与 `dsh plugin list` 输出重装。', '');
  }

  // -------------------------------------------------------------------------
  // 10. MCP / Agent Preset 行恢复说明
  // -------------------------------------------------------------------------
  push('## 10. MCP / Agent Preset 行恢复说明', '');
  push('MCP 与 Agent Preset **没有独立的安装产物**，权威配置就是补丁 YAML（`cordis.patch.yml`）里的行。恢复对应补丁文件后行即恢复；重启 DSH 后在设置页确认生效。', '');

  push('### 10.1 MCP 行（`@deepseek-ai/dsh-mcp-client`）', '');
  push(table(
    ['补丁文件', '行 id', '插件名', '状态'],
    mcpRows.map((item) => [code(item?.file), toStr(item?.rowId ?? item?.id) || '—', toStr(item?.name) || '—', item?.disabled === true ? '已禁用' : '启用']),
  ), '');
  push('- `config` 通常含 `serverName / transport / command / args / env / url / headers`；');
  push('- 若 `command` / `args` / `cwd` 指向本地脚本或目录，必须同时恢复「11. 外部文件对照表」中的对应条目；');
  push('- `env` / `headers` 里的凭据不会写进本文件：恢复后请按目标机重新填写，并确认 MCP 连接成功。', '');

  push('### 10.2 Agent Preset 行（`@deepseek-ai/dsh-agent-preset`）', '');
  push(table(
    ['补丁文件', '行 id', '插件名', '状态'],
    presetRows.map((item) => [code(item?.file), toStr(item?.rowId ?? item?.id) || '—', toStr(item?.name) || '—', item?.disabled === true ? '已禁用' : '启用']),
  ), '');
  push('- `config` 通常含 `id / name / description / order / plugins`；恢复补丁行即恢复预设定义；');
  push('- 若预设引用 workspace 里的源文件，需一并恢复「11」中的对应目录。', '');

  push('### 10.3 Preset Registry 行（`@deepseek-ai/dsh-agent-preset-registry`）', '');
  push(table(
    ['补丁文件', '行 id', '插件名', '状态'],
    presetRegistryRows.map((item) => [code(item?.file), toStr(item?.rowId ?? item?.id) || '—', toStr(item?.name) || '—', item?.disabled === true ? '已禁用' : '启用']),
  ), '');
  push('- 旧版预设目录 `$DSH_HOME/.agent-presets/<id>/` 属于外部文件，按「11」恢复；');
  push('- DSH 版本不同时，行内插件名/字段可能变化：重启后如预设不可见，按目标版本字段手工调整。', '');

  const configRowsForDoc = [...mcpRows, ...presetRows, ...presetRegistryRows]
    .filter((item) => toStr(item?.configText).trim())
    .slice(0, 10);
  if (configRowsForDoc.length > 0) {
    push('### 10.4 行配置原文（已脱敏，便于手工重填）', '');
    push('> 仅用于对照字段；其中形似密钥的值已替换为「（已省略）」。完整原文见快照内 `cordis.patch.yml`。', '');
    for (const item of configRowsForDoc) {
      const labelName = toStr(item?.name) || '插件行';
      const labelId = firstStr(item?.rowId, item?.id) || '?';
      push(`**${mdCell(labelName, 80)}（行 \`${labelId}\`）** — ${code(item?.file)}`, '');
      push('```yaml');
      push(clipText(redactSecrets(item.configText), 1200));
      push('```', '');
    }
  }

  // -------------------------------------------------------------------------
  // 11. 外部文件对照表
  // -------------------------------------------------------------------------
  push('## 11. 外部文件对照表', '');
  push('以下条目是**插件代码本体之外**、但 DSH 运行时确实会被读取/执行的文件：', '');
  if (externalFiles.length > 0) {
    push(table(
      ['类型', '原始路径（source）', '快照内路径', '恢复目标（记录值）', '当前机器路径', '判定理由', '备注'],
      externalFiles.map((entry) => [
        kindLabel(entry?.kind),
        code(firstStr(entry?.source, entryTargetRaw(entry)) || '—'),
        code(firstStr(entry?.archivePath, entry?.archive, entry?.path) || '—'),
        code(entryTargetRaw(entry) || '—'),
        targetDisplay(entry, decode),
        mdCell(firstStr(entry?.why), 160) || '—',
        mdCell(firstStr(entry?.note), 120) || '—',
      ]),
    ), '');
  } else {
    push('（快照中没有额外外部文件条目。）', '');
  }
  push('- 目标路径是快照生成机上的绝对路径；目标机路径不同（workspace 迁移、用户名不同）时，按当前机器映射后记录；');
  push('- 目录条目请整目录复制，不要只挑部分文件；符号链接按原指向重建；');
  push('- 若文档标注「未打包，需手工处理」，按说明从原环境迁移或重新安装。', '');

  // -------------------------------------------------------------------------
  // 12. 校验方式
  // -------------------------------------------------------------------------
  push('## 12. 校验方式', '');
  push('1. **文件落位**：按「7. 路径对照表」逐条确认目标文件存在，大小与快照一致；');
  push('2. **哈希校验**：`manifest.json` 中记录了 sha256 的条目，用 `sha256sum` 对比；');
  push('3. **配置可解析**：`package.json` 必须能被 `JSON.parse`，`cordis.patch.yml` 必须能被 DSH 正常加载（可先备份再启动验证）；');
  push('4. **依赖完整**：`pnpm install --frozen-lockfile` 无报错，`dsh plugin --profile <name> list` 与「9」清单一致；');
  push('5. **Skill / MCP / Agent Preset**：重启后在 UI/设置页确认数量、连接状态、列表与快照一致；');
  push('6. **启动日志**：DSH 重启后检查日志无插件加载错误；');
  push('7. **AI 恢复复核**：使用「AI 恢复」时，恢复 AI 会用 `restore_compare` 做条目级对比，以运行日志为准。', '');
  push('```bash');
  push(`sha256sum <目标文件>                                  # 与 manifest.json 的 sha256 对比`);
  push(`node -e "JSON.parse(require('node:fs').readFileSync('${profilePath}/package.json','utf8'))"`);
  push(`cd ${profilePath} && pnpm install --frozen-lockfile`);
  push(`dsh plugin --profile ${profile} list`);
  push('```', '');

  // -------------------------------------------------------------------------
  // 13. 失败回滚
  // -------------------------------------------------------------------------
  push('## 13. 失败回滚', '');
  push('- **恢复前快照（唯一可靠手段）**：Host 在每次恢复开始前自动创建一份 `pre-restore` 快照（名称「恢复前快照」，只保留最近一次）。恢复失败或结果不符合预期时，在 `dsh-backup-all` 的恢复入口选择该记录再次恢复，即可回到恢复前状态。**不要先删除它。**', '');
  push('- **运行期安全备份**：Host 在写回前会把被覆盖的原文件备份到**本次运行的临时目录**（`.restore-safety/`），但运行结束会随临时目录一起清理；不要依赖它做手工回滚。', '');
  push('- **手工回滚**：先停止 DSH → 用「恢复前快照」重新恢复（推荐）→ 重新启动 DSH；', '');
  push('- **快照损坏**（解包失败/条目异常）：立即停止，不要继续写文件；保留现场，改用其他快照或恢复前快照；', '');
  push('- 回滚后同样需要**重启 DSH** 使配置生效。', '');

  // -------------------------------------------------------------------------
  // 14. 恢复后自检清单
  // -------------------------------------------------------------------------
  push('## 14. 恢复后自检清单', '');
  push('- [ ] DSH 版本与「3. 环境要求」一致（或已确认兼容）；');
  push(`- [ ] profile 名/路径与快照一致（本快照为 ${code(profile)}），或已按目标机正确映射；`);
  push('- [ ] 「8. 配置文件说明」中的文件全部到位（`package.json`、`cordis.patch.yml`、`cordis.yml`、lockfile、home patch 等）；');
  push('- [ ] 「7. 路径对照表」条目数 = 实际写回条目数（允许明确标注的未恢复项）；');
  push('- [ ] 编码目标（`$DSH_HOME/...`、`$DSH_PROFILE_DIR/...`、`$WORKSPACE:...`）已按当前机器正确映射，`unmapped` 项已人工处理；');
  push('- [ ] 有 sha256 的条目哈希校验通过；');
  push('- [ ] `pnpm install --frozen-lockfile` 成功，依赖完整；');
  push(`- [ ] \`dsh plugin --profile ${profile} list\` 与快照插件清单一致；`);
  push('- [ ] 「11. 外部文件对照表」中的目录/文件已恢复且非空；');
  push('- [ ] MCP 行连接成功（或已在摘要中标注需人工确认）；');
  push('- [ ] Agent Preset 行在 UI 中可见/可用；');
  push('- [ ] 已重启 DSH 并检查日志无报错；');
  if (pluginCodeIncluded) {
    push('- [ ] 已入包插件代码已解出到 codeTarget（或重映射目录）并重新执行 `dsh plugin add file:<目录>`；');
  } else {
    push('- [ ] 仍未拿到代码的本地插件，已按「9」的 source/spec 找回或重新链接；');
  }
  push('- [ ] 路径重映射/fallback 条目已按恢复摘要逐项确认（外部文件是否要移动回原位）；');
  push(credentialsIncluded
    ? '- [ ] 已轮换 `.credentials.yaml` 等凭据（压缩包中为明文）；'
    : '- [ ] 已重新填写模型/插件 API Key 等凭据（本快照未打包凭据）；');
  push('- [ ] 需人工确认项已记录（凭据重填、外部服务、模型配置、workspace 路径等）；');
  push('- [ ] 若恢复失败：已用「恢复前快照」回滚，并记录失败原因。', '');

  // -------------------------------------------------------------------------
  // 15. 附录
  // -------------------------------------------------------------------------
  push('## 15. 附录', '');
  push('### 15.1 排除项（快照不包含）', '');
  if (excluded.length > 0) {
    push(table(
      ['路径', '原因'],
      excluded.map((item) => [code(item?.path), mdCell(firstStr(item?.why), 200) || '—']),
    ), '');
  } else {
    push(pluginCodeIncluded
      ? '清单未记录排除项。无论如何，DSH 会话/存储/缓存/日志与 DSH 安装目录均不在快照内（插件代码已按策略部分/全部入包）。'
      : '清单未记录排除项。无论如何，DSH 会话/存储/缓存/日志、插件代码本体与 DSH 安装目录均不在快照内。', '');
  }

  push('### 15.2 扫描警告', '');
  const warnings = toArr(inventory.warnings);
  if (warnings.length > 0) {
    for (const warning of warnings) push(`- ${mdCell(warning, 300)}`);
    push('');
  } else {
    push('（无）', '');
  }

  push('### 15.3 快照包内结构', '');
  push('```text');
  push('manifest.json      # 机器可读：inventory + 文件条目 + 插件元数据 + 排除项 + 元信息');
  push('RESTORE.md         # 本文件（AI 正文 + Host 自动渲染的清单与步骤）');
  push('restore-plan.json  # 结构化恢复计划');
  push('INVENTORY.md       # 环境清单摘要（中文表格）');
  push('files/...          # 按 target 相对路径归档的实际文件');
  push('```', '');

  push('### 15.4 命令速查', '');
  push('```bash');
  push(`dsh plugin --profile ${profile} list                      # 查看已安装插件`);
  push(`dsh plugin --profile ${profile} add <spec>                # 安装插件（spec 见「9」）`);
  push(`cd ${profilePath} && pnpm install --frozen-lockfile        # 按 lockfile 复现依赖`);
  push('sha256sum <文件>                                          # 校验哈希');
  push('```', '');
  push('### 15.5 说明', '');
  push('- 压缩格式：`tar` + Brotli Q11（Node 内建 zlib），文件名形如 `<年>-<月>-<日> <时>-<分>-<秒>.backup.tar.br`；');
  push('- 本文件由 `lib/restore-doc.js` 的 `renderRestoreDoc()` 生成；机器数据以 `manifest.json` 为准；');
  push('- 快照 AI 撰写的正文位于「5. 快照说明（AI 撰写）」，Host 未改动其内容（仅调整标题层级）。');

  return `${out.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// 恢复方式提示（RESTORE.md 内部使用）
// ---------------------------------------------------------------------------

/** 把依赖声明串转成可执行的 add spec（区分本地路径 / 版本范围 / git-url） */
function toInstallSpec(rawSpec, name) {
  const raw = toStr(rawSpec).trim();
  if (!raw) return '';
  if (/^(file:|link:)/i.test(raw)) return raw.replace(/^link:/i, 'file:');
  if (/^(\.{1,2}[\\/]|~[\\/]|[\\/])/.test(raw)) return 'file:' + raw;
  // 版本范围 / tag：npm/pnpm 需要 name@range
  if (/^[\^~<>=\d*]/.test(raw) || /^(latest|next|beta|canary|rc)$/i.test(raw)) {
    return name ? `${name}@${raw}` : raw;
  }
  // git+ / github: / http(s) / npm:alias：原样可用
  return raw;
}

function bundleSpec(bundle) {
  const name = toStr(bundle?.name).trim();
  const version = toStr(bundle?.version).trim();
  const source = toStr(bundle?.source).trim();
  // 本地 bundle：必须用 file: 指向源码目录，不能生成 name@version（registry 里可能不存在）
  if (source && !/^(installation|profile|missing)$/i.test(source)) {
    const spec = toInstallSpec(source, name);
    if (spec) return spec;
  }
  if (!name) return '<bundle>';
  return version ? `${name}@${version}` : name;
}

function pluginSpec(plugin) {
  const name = toStr(plugin?.packageName ?? plugin?.name).trim();
  const version = toStr(plugin?.version).trim();
  const explicit = toStr(plugin?.spec).trim();
  if (explicit) {
    const spec = toInstallSpec(explicit, name);
    if (spec) return spec;
  }
  const source = toStr(plugin?.source).trim();
  if (source && !/^(installation|profile|missing)$/i.test(source)) {
    const spec = toInstallSpec(source, name);
    if (spec) return spec;
  }
  if (!name) return '';
  return version ? `${name}@${version}` : name;
}

function bundleRestoreHint(bundle, profile) {
  const availability = toStr(bundle?.availability);
  if (availability === 'installation') return '随 DSH 安装，无需重装（需版本匹配）';
  const spec = bundleSpec(bundle);
  if (availability === 'profile') return `位于 profile；缺包时：\`dsh plugin --profile ${profile} add ${spec}\``;
  if (availability === 'missing') return `当前缺失，需重装：\`dsh plugin --profile ${profile} add ${spec}\``;
  return availability ? `可用性 ${availability}；缺包时按 \`dsh plugin add\` 重装` : '见 manifest';
}

function pluginRestoreHint(plugin, profile) {
  const codeTarget = firstStr(plugin?.codeTarget);
  if (plugin?.packed === true && codeTarget) {
    const archive = firstStr(plugin?.codeArchivePath);
    return `已入包：把${archive ? ' `' + archive + '`' : '对应 plugin-code 条目'}解出到 \`${codeTarget}\`（跨机按自动重映射结果），再 \`dsh plugin --profile ${profile} add file:<解出后的目录>\``;
  }
  const linkTarget = firstStr(plugin?.linkTarget);
  if (linkTarget) {
    return `本地 file: 插件（代码未入包）：先确保 \`${linkTarget}\` 存在，再 \`dsh plugin --profile ${profile} add file:${linkTarget}\``;
  }
  if (plugin?.external === true || plugin?.externalToProfile === true) {
    return `本地 file: 插件（代码未入包）：需把原始源码目录放回/链接后再 \`dsh plugin --profile ${profile} add file:<目录>\``;
  }
  const spec = pluginSpec(plugin);
  return spec ? `\`dsh plugin --profile ${profile} add ${spec}\`` : '见 package.json';
}

// ---------------------------------------------------------------------------
// 入口：INVENTORY.md
// ---------------------------------------------------------------------------

/**
 * 由 manifest 渲染 INVENTORY.md（环境清单摘要，中文表格）。
 * 兼容两种输入：完整 manifest（含 inventory 字段）或直接传入 inventory 对象。
 * @param {object} manifest
 * @returns {string} Markdown 文本
 */
export function renderInventoryDoc(manifest = {}) {
  const source = isObj(manifest) ? manifest : {};
  const inventoryLike = Array.isArray(source.configFiles)
    || Array.isArray(source.bundles)
    || Array.isArray(source.plugins)
    || Array.isArray(source.skills);
  const inventory = isObj(source.inventory) ? source.inventory : inventoryLike ? source : {};
  const meta = source;
  const snapshotMeta = isObj(meta.snapshot) ? meta.snapshot : {};

  const name = firstStr(snapshotMeta.name, meta.name) || '未命名快照';
  const description = firstStr(snapshotMeta.description, meta.description);
  const createdAt = firstStr(meta.createdAt);
  const archive = isObj(meta.archive) ? meta.archive : {};
  const archiveFile = firstStr(meta.file, archive.file, meta.archiveFile);
  const archiveBytes = firstNum(archive.bytes, meta.bytes);
  const ratio = firstNum(archive.ratio, meta.ratio);
  const files = toArr(meta.files ?? meta.entries);
  const decodeEnv = {
    dshHome: firstStr(inventory.dshHome, meta.environment?.dshHome),
    profileDir: firstStr(inventory.profileDir, meta.environment?.profileDir),
  };
  const workspaces = toArr(meta.workspaces);
  const decode = (encoded) => decodeTargetPath(encoded, decodeEnv, workspaces);

  const configFiles = toArr(inventory.configFiles);
  const bundles = toArr(inventory.bundles);
  const plugins = toArr(inventory.plugins);
  const skills = toArr(inventory.skills);
  const skillRoots = toArr(inventory.skillRoots);
  const patchRows = toArr(inventory.patchRows);
  const mcpRows = toArr(inventory.mcpRows);
  const presetRows = toArr(inventory.presetRows);
  const presetRegistryRows = toArr(inventory.presetRegistryRows);
  const externalCandidates = toArr(inventory.externalCandidates);
  const excluded = toArr(inventory.excluded);
  const warnings = toArr(inventory.warnings);

  const dshHome = firstStr(inventory.dshHome);
  const profileName = firstStr(inventory.profileName);
  const profileDir = firstStr(inventory.profileDir);

  const out = [];
  const push = (...lines) => out.push(...lines);

  push('# DSH 环境清单（INVENTORY.md）', '');
  push('> 本文件由 `dsh-backup-all` 根据环境扫描结果自动渲染，用于快速了解快照内容；机器可读数据见同包 `manifest.json`。');
  push('> 凭据文件只记录路径，不包含任何内容。', '');
  push(
    `> 快照：**${mdCell(name, 160)}**`
    + `${description ? ` ｜ 描述：${mdCell(description, 200)}` : ''}`
    + `${createdAt ? ` ｜ 创建时间：${fmtTime(createdAt)}` : ''}`
    + `${archiveFile ? ` ｜ 归档：\`${archiveFile}\`` : ''}`,
    '',
  );

  push('## 1. 基本信息', '');
  push(table(['项目', '值'], [
    ['清单生成时间', fmtTime(inventory.generatedAt)],
    ['DSH_HOME', dshHome ? code(dshHome) : '—'],
    ['profile 名', profileName ? code(profileName) : '—'],
    ['profile 目录', profileDir ? code(profileDir) : '—'],
    ['DSH 版本', firstStr(inventory.dshVersion) || '（未记录）'],
    ['压缩后大小', fmtBytes(archiveBytes)],
    ['压缩率', fmtRatio(ratio)],
    ['快照文件条目数', String(files.length)],
  ]), '');

  push('## 2. 配置文件清单', '');
  push(table(
    ['文件路径', '作用 / 角色', '存在', '大小', 'sha256（前 16 位）'],
    configFiles.map((item) => [
      code(item?.path),
      mdCell(roleLabel(item?.role), 200),
      item?.exists === false ? '否' : '是',
      fmtBytes(item?.bytes),
      shaShort(item?.sha256),
    ]),
  ), '');

  push('## 3. 插件包（bundles）', '');
  push(table(
    ['名称', '版本', '可用性', '已启用', '安装来源', '插件行', '包目录'],
    bundles.map((item) => [
      toStr(item?.name),
      toStr(item?.version) || '—',
      toStr(item?.availability) || '—',
      item?.enabled === false ? '否' : '是',
      toStr(item?.source) || '—',
      toArr(item?.rows).map((row) => toStr(row?.rowId ?? row)).filter(Boolean).join(', ') || '—',
      firstStr(item?.packageDir) ? code(item.packageDir) : '—',
    ]),
  ), '');

  push('## 4. profile 依赖与本地插件', '');
  push(table(
    ['包名', '版本', '类型', '外部包', '可再下载', '代码入包', '链接目标（file:）', '包目录'],
    plugins.map((item) => [
      toStr(item?.packageName ?? item?.name),
      toStr(item?.version) || '—',
      toStr(item?.kind) || '—',
      item?.externalToProfile === true || item?.external === true ? '是' : '否',
      item?.redownloadable === false ? '否（本地）' : item?.redownloadable === true ? '是' : '未知',
      item?.packed === true ? '是' : '否',
      firstStr(item?.linkTarget) ? code(item.linkTarget) : '—',
      firstStr(item?.packageDir) ? code(item.packageDir) : '—',
    ]),
  ), '');
  if (inventory.snapshotPolicy) {
    push('> 快照策略：插件代码打包 = `' + toStr(inventory.snapshotPolicy.packPluginCode) + '`；凭据文件 = ' + (inventory.snapshotPolicy.credentialsIncluded ? '已入包（明文，请妥善保管）' : '未入包（恢复后重填）') + '。', '');
  }

  push('## 5. Skill', '');
  push(table(
    ['名称', '来源', '路径', '根目录', '外部', '大小'],
    skills.map((item) => [
      toStr(item?.name),
      toStr(item?.source) || '—',
      code(item?.path),
      firstStr(item?.root) ? code(item.root) : '—',
      item?.external === true ? '是' : '否',
      fmtBytes(item?.sizeBytes),
    ]),
  ), '');

  push('## 6. Skill 根目录', '');
  push(table(
    ['根路径', '来源', '存在', 'Skill 数量'],
    skillRoots.map((item) => [
      code(item?.path),
      toStr(item?.source) || '—',
      item?.exists === false ? '否' : '是',
      item?.count === undefined ? '—' : String(item.count),
    ]),
  ), '');

  push('## 7. 补丁行（cordis.patch.yml）', '');
  push(table(
    ['文件', '行 id', '插件名', '禁用'],
    patchRows.map((item) => [
      code(item?.file),
      toStr(item?.id ?? item?.rowId) || '—',
      toStr(item?.name) || '—',
      item?.disabled === true ? '是' : '否',
    ]),
  ), '');

  push('## 8. MCP 行', '');
  push(table(
    ['文件', '行 id', '插件名'],
    mcpRows.map((item) => [code(item?.file), toStr(item?.rowId ?? item?.id) || '—', toStr(item?.name) || '—']),
  ), '');

  push('## 9. Agent Preset 行', '');
  push(table(
    ['文件', '行 id', '插件名'],
    presetRows.map((item) => [code(item?.file), toStr(item?.rowId ?? item?.id) || '—', toStr(item?.name) || '—']),
  ), '');

  push('## 10. Preset Registry 行', '');
  push(table(
    ['文件', '行 id', '插件名'],
    presetRegistryRows.map((item) => [code(item?.file), toStr(item?.rowId ?? item?.id) || '—', toStr(item?.name) || '—']),
  ), '');

  push('## 11. 外部文件候选（扫描结果）', '');
  push('> 这些是扫描判定为「插件本体之外」的候选；实际入包条目以「12. 快照文件条目」与 `manifest.json` 为准。', '');
  push(table(
    ['路径', '类型', '判定理由'],
    externalCandidates.map((item) => [code(item?.path), toStr(item?.kind) || '—', mdCell(item?.why, 200) || '—']),
  ), '');

  push('## 12. 快照文件条目', '');
  push(table(
    ['类型', '原始路径', '快照内路径', '恢复目标（记录值）', '当前机器路径', '备注'],
    files.map((entry) => [
      kindLabel(entry?.kind),
      code(firstStr(entry?.source, entryTargetRaw(entry)) || '—'),
      code(firstStr(entry?.archivePath, entry?.archive, entry?.path) || '—'),
      code(entryTargetRaw(entry) || '—'),
      targetDisplay(entry, decode),
      mdCell(firstStr(entry?.note, entry?.why), 120) || '—',
    ]),
  ), '');

  push('## 13. 排除项', '');
  push(table(
    ['路径', '原因'],
    excluded.map((item) => [code(item?.path), mdCell(firstStr(item?.why), 200) || '—']),
  ), '');

  push('## 14. 扫描警告', '');
  if (warnings.length > 0) {
    for (const warning of warnings) push(`- ${mdCell(warning, 300)}`);
    push('');
  } else {
    push('（无）', '');
  }

  push('## 15. 快照包结构', '');
  push('```text');
  push('manifest.json      # 机器可读：inventory + 文件条目 + 插件元数据 + 排除项 + 元信息');
  push('RESTORE.md         # 恢复说明（AI 正文 + 自动清单/对照表/固定步骤）');
  push('restore-plan.json  # 结构化恢复计划');
  push('INVENTORY.md       # 本文件');
  push('files/...          # 按 target 相对路径归档的实际文件');
  push('```', '');

  return `${out.join('\n').trimEnd()}\n`;
}
