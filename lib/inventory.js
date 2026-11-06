/**
 * lib/inventory.js — DSH 已安装项扫描（纯 fs，无 ctx 依赖）
 *
 * 职责：把「这台机器上的 DSH 安装了什么」整理成一份确定性的结构清单，交给 runner / AI 使用：
 *   - configFiles      profile / $DSH_HOME 下的关键配置文件（存在性、大小、sha256）
 *   - bundles          已安装/可选 bundle 清单（来自 pluginManager.listBundles，不可用时用文件兜底）
 *   - plugins          profile node_modules 里安装的插件包（含 file: 本地插件的外部来源）
 *   - patchRows        补丁 YAML 的「行」扫描（MCP / Agent Preset / 普通行），mcpRows 等是它的子集
 *   - skills           用户级 / workspace 级 Skill bundle 与平铺 *.md
 *   - externalCandidates  需要 AI 决定是否作为「外部文件」打包的候选路径
 *   - excluded         明确不读、不打包的本机内部路径
 *   - warnings         所有 IO 失败的降级记录（扫描永不整体抛错，AbortSignal 除外）
 *
 * 设计原则：
 *   1. 只读；不读 $DSH_HOME/.credentials.yaml、sessions、storages。
 *   2. 任何单个文件/目录的失败都只写 warnings，不中断整体扫描。
 *   3. 大小统计有上限（maxDirBytes），不跟随符号链接（目标由 externalCandidates 记录）。
 *   4. 输出字段名严格按 docs/MODULE-CONTRACTS.md 的 B 节，前端/提示词依赖。
 */

import { promises as fsp, createReadStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const DEFAULT_MAX_DIR_BYTES = 200 * 1024 * 1024
/** 单个配置文件 / 补丁文件的读取上限（防护异常大文件把内存吃掉） */
const MAX_TEXT_BYTES = 16 * 1024 * 1024
/** Skill frontmatter 只读头部，避免整文件读入 */
const SKILL_HEAD_BYTES = 16 * 1024
const MAX_WARNINGS = 400

const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
const PRESET_REGISTRY_MODULE = '@deepseek-ai/dsh-agent-preset-registry'

/** $DSH_HOME 一级子目录里属于 DSH 内部的项，不作为「插件数据目录」候选 */
const INTERNAL_HOME_NAMES = new Set([
  'profiles',
  'sessions',
  'storages',
  'dshbox',
  'skills',
  'node_modules',
  '.agent-presets',
  'backup',
  'backups',
])

/** 行扫描：`- id: xxx` 作为补丁行的开始（允许任意缩进，用于 insert 列表里的行） */
const ROW_START_RE = /^(\s*)-\s+id:\s+(\S.*)$/
/** Skill frontmatter 的 name 行 */
const FRONTMATTER_NAME_RE = /^name:\s*(.+?)\s*$/

const isMissing = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'ELOOP')
const fmtErr = (err) => (err && err.message ? err.message : String(err))

/** 中止错误：与普通 IO 错误区分，扫描入口会原样抛出而不吞进 warnings */
function abortError() {
  const err = new Error('扫描已中止')
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError()
}

function createContext(opts) {
  const dshHome = path.resolve(
    opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  )
  const profileName = opts.profileName || process.env.DSH_PROFILE || 'web'
  const profileDir = path.resolve(
    opts.profileDir || path.join(dshHome, 'profiles', profileName),
  )
  return {
    dshHome,
    profileDir,
    profileName,
    homeDir: path.resolve(opts.homeDir || os.homedir()),
    pluginPackageName: typeof opts.pluginPackageName === 'string' && opts.pluginPackageName
      ? opts.pluginPackageName
      : null,
    installationNodeModules: opts.installationNodeModules
      ? path.resolve(opts.installationNodeModules)
      : null,
    maxDirBytes: Number.isFinite(opts.maxDirBytes) && opts.maxDirBytes > 0
      ? Math.floor(opts.maxDirBytes)
      : DEFAULT_MAX_DIR_BYTES,
    signal: opts.signal ?? null,
    warnings: [],
    profilePackage: null,
    profileReal: profileDir,
  }
}

function warn(ctx, message) {
  const text = String(message)
  if (!text || ctx.warnings.length >= MAX_WARNINGS) return
  if (!ctx.warnings.includes(text)) ctx.warnings.push(text)
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function realpathOr(ctx, target) {
  try {
    return await fsp.realpath(target)
  } catch (err) {
    if (!isMissing(err)) warn(ctx, `realpath 失败 ${target}: ${fmtErr(err)}`)
    return path.resolve(target)
  }
}

/** stat（跟随符号链接）；不存在返回 null；其它错误降级为 warning + null */
async function statSafe(ctx, target) {
  try {
    return await fsp.stat(target)
  } catch (err) {
    if (isMissing(err)) return null
    warn(ctx, `无法读取路径 ${target}: ${fmtErr(err)}`)
    return null
  }
}

async function lstatSafe(ctx, target) {
  try {
    return await fsp.lstat(target)
  } catch (err) {
    if (isMissing(err)) return null
    warn(ctx, `无法读取路径 ${target}: ${fmtErr(err)}`)
    return null
  }
}

async function isFile(ctx, target) {
  const st = await statSafe(ctx, target)
  return Boolean(st && st.isFile())
}

async function isDirectory(ctx, target) {
  const st = await statSafe(ctx, target)
  return Boolean(st && st.isDirectory())
}

async function readJsonSafe(ctx, target) {
  const st = await statSafe(ctx, target)
  if (!st || !st.isFile()) return null
  if (st.size > MAX_TEXT_BYTES) {
    warn(ctx, `文件过大，跳过读取 ${target}（${st.size} 字节）`)
    return null
  }
  try {
    const text = await fsp.readFile(target, 'utf8')
    return JSON.parse(text)
  } catch (err) {
    warn(ctx, `读取/解析 JSON 失败 ${target}: ${fmtErr(err)}`)
    return null
  }
}

async function readTextSafe(ctx, target) {
  const st = await statSafe(ctx, target)
  if (!st || !st.isFile()) return null
  if (st.size > MAX_TEXT_BYTES) {
    warn(ctx, `文件过大，跳过读取 ${target}（${st.size} 字节）`)
    return null
  }
  try {
    return await fsp.readFile(target, 'utf8')
  } catch (err) {
    warn(ctx, `读取文本失败 ${target}: ${fmtErr(err)}`)
    return null
  }
}

async function hashFileSafe(ctx, target) {
  const st = await statSafe(ctx, target)
  if (!st || !st.isFile()) return null
  if (st.size > MAX_TEXT_BYTES) {
    warn(ctx, `文件过大，跳过 sha256 ${target}（${st.size} 字节）`)
    return null
  }
  try {
    return await new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(target)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  } catch (err) {
    warn(ctx, `计算 sha256 失败 ${target}: ${fmtErr(err)}`)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 目录大小统计                                                         */
/* ------------------------------------------------------------------ */

/**
 * 递归统计目录大小（不跟随符号链接；符号链接本身记 0）。
 * @returns {Promise<{bytes:number, capped:boolean}>} capped=true 表示超过 maxBytes 已截断。
 */
async function dirSize(ctx, root, maxBytes = ctx.maxDirBytes) {
  const result = { bytes: 0, capped: false }
  throwIfAborted(ctx.signal)
  if (!root) return result

  const rootStat = await lstatSafe(ctx, root)
  if (!rootStat) return result
  if (rootStat.isSymbolicLink()) return result // 不跟随符号链接
  if (rootStat.isFile()) {
    if (rootStat.size > maxBytes) {
      result.bytes = maxBytes
      result.capped = true
    } else {
      result.bytes = rootStat.size
    }
    return result
  }
  if (!rootStat.isDirectory()) return result

  const stack = [root]
  while (stack.length > 0) {
    throwIfAborted(ctx.signal)
    const dir = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (!isMissing(err)) warn(ctx, `无法统计目录 ${dir}: ${fmtErr(err)}`)
      continue
    }
    for (const entry of entries) {
      throwIfAborted(ctx.signal)
      if (entry.isSymbolicLink()) continue // 符号链接本身记 0
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      let st
      try {
        st = await fsp.lstat(full)
      } catch (err) {
        if (!isMissing(err)) warn(ctx, `无法统计文件 ${full}: ${fmtErr(err)}`)
        continue
      }
      result.bytes += st.size
      if (result.bytes > maxBytes) {
        result.bytes = maxBytes
        result.capped = true
        return result
      }
    }
  }
  return result
}

/** 统计目录大小并在截断时写 warning；返回字节数（符号链接为 0） */
async function measureDir(ctx, target, label) {
  if (!target) return 0
  const size = await dirSize(ctx, target)
  if (size.capped) {
    warn(
      ctx,
      `size-capped: ${label || target} 超过 maxDirBytes=${ctx.maxDirBytes}，大小统计已截断`,
    )
  }
  return size.bytes
}

/* ------------------------------------------------------------------ */
/* 配置文件                                                             */
/* ------------------------------------------------------------------ */

const CONFIG_FILE_SPECS = [
  ['package.json', 'profile-package'],
  ['cordis.patch.yml', 'profile-patch'],
  ['cordis.yml', 'profile-root'],
  ['pnpm-lock.yaml', 'profile-lock'],
  ['pnpm-workspace.yaml', 'profile-lock'],
]

async function configFileEntry(ctx, file, role) {
  const st = await statSafe(ctx, file)
  const entry = { path: file, role, exists: false, bytes: null, sha256: null }
  if (!st || !st.isFile()) return entry
  entry.exists = true
  entry.bytes = st.size
  entry.sha256 = await hashFileSafe(ctx, file)
  return entry
}

async function scanConfigFiles(ctx) {
  const out = []
  for (const [rel, role] of CONFIG_FILE_SPECS) {
    throwIfAborted(ctx.signal)
    out.push(await configFileEntry(ctx, path.join(ctx.profileDir, rel), role))
  }
  out.push(await configFileEntry(ctx, path.join(ctx.dshHome, 'cordis.patch.yml'), 'home-patch'))
  out.push(
    await configFileEntry(
      ctx,
      path.join(ctx.dshHome, 'dshbox', 'plugin-guard.json'),
      'plugin-guard',
    ),
  )
  out.push(...(await scanLegacyPresetFiles(ctx)))
  return out
}

/** 旧版 Agent Preset 目录：$DSH_HOME/.agent-presets/<id>/{preset.yml,agent.cordis.yml}（兼容扫描） */
async function scanLegacyPresetFiles(ctx) {
  const dir = path.join(ctx.dshHome, '.agent-presets')
  const st = await lstatSafe(ctx, dir)
  if (!st || !st.isDirectory()) return []
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    warn(ctx, `无法读取旧版 preset 目录 ${dir}: ${fmtErr(err)}`)
    return []
  }
  const files = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    let kind = entry
    if (entry.isSymbolicLink()) {
      kind = await statSafe(ctx, full)
      if (!kind) continue
    }
    if (kind.isDirectory()) {
      for (const known of ['preset.yml', 'agent.cordis.yml']) {
        const file = path.join(full, known)
        if (await isFile(ctx, file)) files.push(file)
      }
    } else if (kind.isFile() && /\.ya?ml$/i.test(entry.name)) {
      files.push(full)
    }
  }
  const out = []
  for (const file of files) {
    throwIfAborted(ctx.signal)
    out.push(await configFileEntry(ctx, file, 'legacy-presets'))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 补丁 YAML 行扫描（启发式，不追求完整 YAML 语义）                     */
/* ------------------------------------------------------------------ */

/** 去掉行内注释与引号，`!!js` 表达式保留原文 */
function parseScalar(raw) {
  let value = String(raw ?? '').trim()
  if (!value) return ''
  if (value.startsWith('!!js')) return value
  const stripQuotes = (text) =>
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
      ? text.slice(1, -1)
      : text
  if (stripQuotes(value) !== value) return stripQuotes(value)
  const comment = value.search(/\s+#/)
  if (comment >= 0) value = value.slice(0, comment).trim()
  return stripQuotes(value)
}

function parseBool(raw) {
  const value = parseScalar(raw).toLowerCase()
  if (value === 'true' || value === 'yes' || value === 'on' || value === '1') return true
  // false / !!js 表达式等静态不可判定值：按「未禁用」记录（原文在 configText 里可查）
  return false
}

function countIndent(line) {
  let n = 0
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n += 1
  return n
}

/**
 * 扫描一段补丁 YAML 文本，抽取出「行」：
 *   - 行开始：`^\s*-\s+id:\s*(\S+)`
 *   - 行块结束：同缩进的 `- ` 列表项，或缩进更浅的非空行
 *   - 块内取 name / disabled（取行字段缩进，即 `- id` 所在缩进 + 2 处的字段）
 *   - configText 保留块的原文（含注释行），便于 AI 再用 backup_read_text 精读
 */
function scanPatchText(text, file) {
  const lines = String(text ?? '').split(/\r?\n/)
  const rows = []
  let i = 0
  while (i < lines.length) {
    const match = ROW_START_RE.exec(lines[i])
    if (!match) {
      i += 1
      continue
    }
    const indent = match[1].length
    const id = parseScalar(match[2])
    const start = i
    i += 1
    while (i < lines.length) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) {
        // 空行与注释不结束行块：补丁文件里注释常嵌在行块之间/内部
        i += 1
        continue
      }
      const lineIndent = countIndent(line)
      if (lineIndent < indent) break
      const rest = line.slice(lineIndent)
      if (lineIndent === indent && rest.startsWith('-')) break
      i += 1
    }
    rows.push(makePatchRow(file, lines.slice(start, i), id, indent))
  }
  return rows
}

function makePatchRow(file, blockLines, id, indent) {
  const fieldIndent = indent + 2 // `- ` 占两列，行字段通常再缩进 2 列
  const nameMatches = []
  const disabledMatches = []
  for (let k = 1; k < blockLines.length; k += 1) {
    const line = blockLines[k]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const lineIndent = countIndent(line)
    if (lineIndent <= indent) continue
    const nameMatch = /^name:\s*(.+)$/.exec(trimmed)
    if (nameMatch) nameMatches.push({ indent: lineIndent, value: parseScalar(nameMatch[1]) })
    const disabledMatch = /^disabled:\s*(.+)$/.exec(trimmed)
    if (disabledMatch) {
      disabledMatches.push({ indent: lineIndent, value: parseBool(disabledMatch[1]) })
    }
  }
  // 行字段缩进处优先；找不到时退化为「块内最浅的 name/disabled」。
  // 退化只接受 fieldIndent+2 以内的缩进，避免把 config 里更深的 name（如 preset 内部插件）误当行字段。
  const pick = (matches) => {
    if (matches.length === 0) return null
    const exact = matches.find((item) => item.indent === fieldIndent)
    if (exact) return exact
    const shallow = matches.filter((item) => item.indent <= fieldIndent + 2)
    if (shallow.length === 0) return null
    return shallow.reduce((best, item) => (item.indent < best.indent ? item : best))
  }
  const nameField = pick(nameMatches)
  const disabledField = pick(disabledMatches)
  const name = nameField?.value || null
  const disabled = disabledField ? disabledField.value : false
  return {
    file,
    id,
    name,
    disabled,
    indent,
    configText: blockLines.join('\n').replace(/\s+$/, ''),
  }
}

function classifyModuleName(name) {
  if (typeof name !== 'string' || !name) return null
  if (name === MCP_MODULE || name.endsWith('/dsh-mcp-client')) return 'mcp'
  if (name === PRESET_MODULE || name.endsWith('/dsh-agent-preset')) return 'preset'
  if (name === PRESET_REGISTRY_MODULE || name.endsWith('/dsh-agent-preset-registry')) {
    return 'preset-registry'
  }
  return null
}

/* ------------------------------------------------------------------ */
/* bundle / plugin 解析                                                 */
/* ------------------------------------------------------------------ */

function profileDependencies(profilePkg) {
  const out = {}
  if (!profilePkg || typeof profilePkg !== 'object') return out
  for (const field of ['dependencies', 'optionalDependencies']) {
    const deps = profilePkg[field]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, spec] of Object.entries(deps)) {
      if (!(name in out)) out[name] = spec
    }
  }
  return out
}

function profileBundleNames(profilePkg) {
  const list = profilePkg?.dsh?.profile?.bundles
  if (!Array.isArray(list)) return []
  return list.filter((name) => typeof name === 'string' && name.length > 0)
}

function resolveFileSpec(ctx, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('file:')) return null
  let raw = spec.slice('file:'.length).trim()
  raw = raw.replace(/^['"]|['"]$/g, '')
  if (!raw) return null
  return path.resolve(ctx.profileDir, raw)
}

async function resolveInstallationPackageDir(ctx, name) {
  const candidates = []
  // 契约 B：先 createRequire(profile/package.json).resolve(<name>/package.json)
  try {
    const requireFromProfile = createRequire(path.join(ctx.profileDir, 'package.json'))
    candidates.push(path.dirname(requireFromProfile.resolve(`${name}/package.json`)))
  } catch {
    /* 解析不到就回退到安装目录（runner 传入的 installationNodeModules） */
  }
  if (ctx.installationNodeModules) {
    candidates.push(path.join(ctx.installationNodeModules, name))
    candidates.push(path.join(ctx.installationNodeModules, 'node_modules', name))
  }
  for (const dir of candidates) {
    if (dir && (await isDirectory(ctx, dir))) return dir
  }
  return null
}

/**
 * 判断一个插件的「可再下载性」——决定了快照要不要把它的代码本体一并打包。
 *  - local / workspace：指向本机目录，换台机器就没了 → 不可再下载，代码必须入包
 *  - registry / git / tarball：有来源 spec，可联网重新安装（可再下载）
 *  - installation：随 DSH 安装提供，同版本可重装（可再下载）
 */
function classifyDependencySource(spec, availability) {
  if (availability === 'installation') {
    return { sourceKind: 'installation', redownloadable: true, spec: null }
  }
  const raw = typeof spec === 'string' ? spec.trim() : ''
  if (!raw) return { sourceKind: 'unknown', redownloadable: 'unknown', spec: null }
  if (/^(file:|link:)/i.test(raw)) return { sourceKind: 'local', redownloadable: false, spec: raw }
  if (/^workspace:/i.test(raw)) return { sourceKind: 'local', redownloadable: false, spec: raw }
  if (/^(\.{1,2}[\\/]|~[\\/]|[\\/])/.test(raw)) return { sourceKind: 'local', redownloadable: false, spec: raw }
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|ssh:)/i.test(raw)) return { sourceKind: 'git', redownloadable: true, spec: raw }
  if (/^https?:/i.test(raw)) {
    if (/\.(tgz|tar\.gz|tar)(\?|#|$)/i.test(raw) || /^https?:\/\/[^/]+\/[^/]+/.test(raw)) {
      return { sourceKind: 'tarball', redownloadable: true, spec: raw }
    }
    return { sourceKind: 'url', redownloadable: true, spec: raw }
  }
  return { sourceKind: 'registry', redownloadable: true, spec: raw }
}

async function resolveProfilePackageDir(ctx, name) {
  const dir = path.join(ctx.profileDir, 'node_modules', name)
  return (await isDirectory(ctx, dir)) ? dir : null
}

/** 读取 bundle 声明的补丁文件（dsh.bundle.patch 支持字符串或字符串数组） */
async function resolveBundlePatchFiles(ctx, packageDir, pkg) {
  const declaration = pkg?.dsh?.bundle?.patch
  if (!packageDir || !declaration) return []
  const list = Array.isArray(declaration) ? declaration : [declaration]
  const files = []
  for (const item of list) {
    throwIfAborted(ctx.signal)
    if (typeof item !== 'string' || !item.trim()) continue
    const abs = path.resolve(packageDir, item)
    try {
      const st = await fsp.stat(abs)
      if (st.isFile()) files.push(abs)
      else warn(ctx, `补丁路径不是文件: ${abs}`)
    } catch (err) {
      warn(ctx, `补丁文件不可用 ${abs}: ${fmtErr(err)}`)
    }
  }
  return files
}

/**
 * 构建 bundles（内部结构，含 patchFiles 等中间字段；返回前由 publicBundles 映射成契约字段）。
 * opts.bundles 不可用时：读 profile/package.json 的 dsh.profile.bundles + node_modules 兜底。
 */
async function buildBundles(ctx, opts, enabledNames) {
  const deps = profileDependencies(ctx.profilePackage)
  const input = Array.isArray(opts.bundles) ? opts.bundles : null
  const metas = []
  const seen = new Set()

  const addMeta = (meta) => {
    if (!meta.name || seen.has(meta.name)) return
    seen.add(meta.name)
    metas.push(meta)
  }

  const describe = async (name, availability, raw) => {
    let packageDir = null
    if (availability === 'profile') packageDir = await resolveProfilePackageDir(ctx, name)
    else if (availability === 'installation') {
      packageDir = await resolveInstallationPackageDir(ctx, name)
    }
    const pkg = packageDir ? await readJsonSafe(ctx, path.join(packageDir, 'package.json')) : null
    const patchFiles = await resolveBundlePatchFiles(ctx, packageDir, pkg)
    const packageSizeBytes = await measureDir(ctx, packageDir, `bundle ${name}`)

    // 外部 bundle：目录（realpath）或 file: 来源落在 profile 之外
    let external = false
    if (packageDir && availability !== 'installation') {
      const profileReal = ctx.profileReal
      const dirReal = await realpathOr(ctx, packageDir)
      if (!isInside(profileReal, dirReal)) external = true
      else {
        const target = resolveFileSpec(ctx, deps[name])
        if (target) {
          const targetReal = await realpathOr(ctx, target)
          external = !isInside(profileReal, targetReal)
        }
      }
    }

    let rows = []
    if (raw && Array.isArray(raw.rows)) {
      rows = raw.rows
        .filter((row) => row && typeof row.rowId === 'string')
        .map((row) => ({
          rowId: row.rowId,
          moduleName: typeof row.moduleName === 'string' ? row.moduleName : '',
        }))
    }

    let enabled
    if (raw && typeof raw.enabled === 'boolean') enabled = raw.enabled
    else enabled = enabledNames.includes(name)

    let installed
    if (raw && typeof raw.installed === 'boolean') installed = raw.installed
    else installed = Boolean(deps[name])

    const source =
      raw && typeof raw.source === 'string'
        ? raw.source
        : typeof deps[name] === 'string'
          ? deps[name]
          : null

    const version =
      (raw && typeof raw.version === 'string' && raw.version) ||
      (pkg && typeof pkg.version === 'string' && pkg.version) ||
      null
    const description =
      (raw && typeof raw.description === 'string' && raw.description) ||
      (raw && raw.meta && typeof raw.meta.description === 'string' ? raw.meta.description : null) ||
      (pkg && typeof pkg.description === 'string' && pkg.description) ||
      null

    addMeta({
      name,
      version,
      description,
      availability,
      source,
      enabled,
      installed,
      rows,
      packageDir,
      patchFiles,
      packageSizeBytes,
      external,
      fallback: false,
    })
  }

  if (input) {
    // 正常路径：来自 pluginManager.listBundles()
    for (const raw of input) {
      throwIfAborted(ctx.signal)
      if (!raw || typeof raw.name !== 'string' || !raw.name) continue
      const name = raw.name
      if (ctx.pluginPackageName && name === ctx.pluginPackageName) continue // 备份插件自身
      let availability = raw.availability
      if (availability !== 'profile' && availability !== 'installation' && availability !== 'missing') {
        // 服务数据缺 availability 时按文件位置探测，别把它当成 missing
        if (await resolveProfilePackageDir(ctx, name)) availability = 'profile'
        else if (await resolveInstallationPackageDir(ctx, name)) availability = 'installation'
        else availability = 'missing'
      }
      await describe(name, availability, raw)
    }
    return metas
  }

  // 兜底路径：profile/package.json 的 dsh.profile.bundles + node_modules
  for (const name of enabledNames) {
    throwIfAborted(ctx.signal)
    if (ctx.pluginPackageName && name === ctx.pluginPackageName) continue
    let availability = 'missing'
    if (await isDirectory(ctx, path.join(ctx.profileDir, 'node_modules', name))) {
      availability = 'profile'
    } else if (await resolveInstallationPackageDir(ctx, name)) {
      availability = 'installation'
    }
    await describe(name, availability, null)
  }
  // profile node_modules 里声明了 bundle 补丁、但未在 dsh.profile.bundles 中启用的依赖也列出来（enabled:false）
  for (const name of Object.keys(deps).sort()) {
    throwIfAborted(ctx.signal)
    if (seen.has(name)) continue
    if (ctx.pluginPackageName && name === ctx.pluginPackageName) continue
    if (name.startsWith('.')) continue
    const packageDir = await resolveProfilePackageDir(ctx, name)
    if (!packageDir) continue
    const pkg = await readJsonSafe(ctx, path.join(packageDir, 'package.json'))
    if (!pkg?.dsh?.bundle?.patch) continue
    await describe(name, 'profile', null)
  }
  // 兜底条目：用补丁行里「声明了 name 的行」近似 bundle 的 rows
  for (const meta of metas) meta.fallback = true
  return metas
}

/** 内部 bundle 结构 → 契约字段（字段名固定，勿改） */
function publicBundles(metas, patchRows) {
  return metas.map((meta) => {
    let rows = meta.rows
    if (meta.fallback && rows.length === 0) {
      const files = new Set(meta.patchFiles)
      rows = patchRows
        .filter((row) => files.has(row.file) && typeof row.name === 'string' && row.name)
        .map((row) => ({ rowId: row.id, moduleName: row.name }))
    }
    return {
      name: meta.name,
      version: meta.version,
      description: meta.description,
      availability: meta.availability,
      source: meta.source,
      enabled: meta.enabled,
      installed: meta.installed,
      rows,
      packageDir: meta.packageDir,
      patchFile: meta.patchFiles[0] ?? null,
      packageSizeBytes: meta.packageSizeBytes,
      external: meta.external,
    }
  })
}

/**
 * 扫描 profile node_modules 里安装的插件包（含 file: 本地插件的外部来源）。
 * kind: 'bundle'（在 bundles 列表里）| 'local-plugin'（来源在 profile 外）| 'dependency'
 */
async function scanPlugins(ctx, bundles) {
  const deps = profileDependencies(ctx.profilePackage)
  const bundleNames = new Set(bundles.map((bundle) => bundle.name))
  const nmDir = path.join(ctx.profileDir, 'node_modules')
  const names = new Set(Object.keys(deps))

  // 扫 node_modules 一级（跳过 .bin/.cache/.pnpm 等内部项），补上未写进 dependencies 的包
  try {
    const entries = await fsp.readdir(nmDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (entry.name.startsWith('@')) {
          try {
            const scoped = await fsp.readdir(path.join(nmDir, entry.name), { withFileTypes: true })
            for (const sub of scoped) {
              if (sub.isDirectory() || sub.isSymbolicLink()) {
                names.add(`${entry.name}/${sub.name}`)
              }
            }
          } catch (err) {
            if (!isMissing(err)) warn(ctx, `无法读取 ${path.join(nmDir, entry.name)}: ${fmtErr(err)}`)
          }
        } else {
          names.add(entry.name)
        }
      }
    }
  } catch (err) {
    if (!isMissing(err)) warn(ctx, `无法读取 profile node_modules: ${fmtErr(err)}`)
  }

  const plugins = []
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    throwIfAborted(ctx.signal)
    if (ctx.pluginPackageName && name === ctx.pluginPackageName) continue // 备份插件自身
    const packageDir = path.join(nmDir, name)
    const linkStat = await lstatSafe(ctx, packageDir)
    if (!linkStat) {
      if (deps[name]) warn(ctx, `依赖未安装: ${name}`)
      continue
    }
    const pkg = await readJsonSafe(ctx, path.join(packageDir, 'package.json'))

    // linkTarget：符号链接目标；hoisted 布局下 file: 依赖没有软链，用 file: 来源补上
    let linkTarget = null
    if (linkStat.isSymbolicLink()) {
      try {
        const raw = await fsp.readlink(packageDir)
        linkTarget = path.resolve(path.dirname(packageDir), raw)
      } catch (err) {
        warn(ctx, `读取符号链接失败 ${packageDir}: ${fmtErr(err)}`)
      }
    }
    const specTarget = resolveFileSpec(ctx, deps[name])
    if (!linkTarget && specTarget) linkTarget = specTarget

    const dirReal = await realpathOr(ctx, packageDir)
    let externalToProfile = !isInside(ctx.profileReal, dirReal)
    if (!externalToProfile && specTarget) {
      const targetReal = await realpathOr(ctx, specTarget)
      externalToProfile = !isInside(ctx.profileReal, targetReal)
    }

    const sizeBytes = await measureDir(ctx, packageDir, `plugin ${name}`)
    let kind = 'dependency'
    if (bundleNames.has(name)) kind = 'bundle'
    else if (externalToProfile) kind = 'local-plugin'

    const spec = typeof deps[name] === 'string' ? deps[name] : null
    const sourceInfo = classifyDependencySource(spec, 'profile')
    // 代码本体实际所在目录：优先 file: 链接目标（本机源码目录），否则 packageDir 的真实路径
    const codeDir = externalToProfile
      ? (specTarget || linkTarget || dirReal)
      : dirReal
    plugins.push({
      packageName: name,
      version: typeof pkg?.version === 'string' ? pkg.version : null,
      packageDir,
      linkTarget: linkTarget ?? null,
      externalToProfile,
      sizeBytes,
      kind,
      spec,
      sourceKind: sourceInfo.sourceKind,
      redownloadable: sourceInfo.redownloadable,
      codeDir: codeDir ?? null,
      // 默认打包策略提示：不可再下载的本地插件代码必须入包；可再下载的默认只记元数据
      packedByDefault: sourceInfo.redownloadable === false,
    })
  }
  return plugins
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

function normalizeWorkspaces(input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const item of input) {
    const candidate = typeof item === 'string' ? item : item?.path
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const abs = path.resolve(candidate)
    if (seen.has(abs)) continue
    seen.add(abs)
    out.push({
      id: typeof item?.id === 'string' ? item.id : null,
      path: abs,
      title: typeof item?.title === 'string' ? item.title : null,
    })
  }
  return out
}

/** 读文件头部（frontmatter 只需要开头） */
async function readHead(ctx, file, maxBytes = SKILL_HEAD_BYTES) {
  try {
    const handle = await fsp.open(file, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch (err) {
    if (!isMissing(err)) warn(ctx, `读取文件头部失败 ${file}: ${fmtErr(err)}`)
    return ''
  }
}

/**
 * 从 SKILL.md / 平铺 md 里取 frontmatter 的 name。
 * 优先带 `---` 分隔的 frontmatter 区域；没有 frontmatter 时在前 40 行里兜底找 `name:`。
 */
function frontmatterName(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  if (lines.length > 0 && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') break
      const match = FRONTMATTER_NAME_RE.exec(lines[i])
      if (match) return parseScalar(match[1]) || null
    }
    return null
  }
  const limit = Math.min(lines.length, 40)
  for (let i = 0; i < limit; i += 1) {
    const match = FRONTMATTER_NAME_RE.exec(lines[i])
    if (match) return parseScalar(match[1]) || null
  }
  return null
}

async function scanSkillRoot(ctx, root) {
  const skills = []
  let entries
  try {
    entries = await fsp.readdir(root.path, { withFileTypes: true })
  } catch (err) {
    if (!isMissing(err)) warn(ctx, `无法读取 Skill 根 ${root.path}: ${fmtErr(err)}`)
    return skills
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    throwIfAborted(ctx.signal)
    if (entry.name.startsWith('.')) continue // $DSH_HOME/skills 里的 .system 等
    const full = path.join(root.path, entry.name)
    let kind = entry
    if (entry.isSymbolicLink()) {
      kind = await statSafe(ctx, full)
      if (!kind) continue
    }
    if (kind.isDirectory()) {
      const skillFile = path.join(full, 'SKILL.md')
      if (!(await isFile(ctx, skillFile))) continue // 不递归发现嵌套 SKILL.md
      const head = await readHead(ctx, skillFile)
      const sizeBytes = await measureDir(ctx, full, `skill ${full}`)
      const real = await realpathOr(ctx, full)
      skills.push({
        name: frontmatterName(head) || entry.name,
        path: full,
        root: root.path,
        source: root.source,
        isDirectory: true,
        sizeBytes,
        external: !isInside(ctx.profileReal, real),
      })
    } else if (kind.isFile() && /\.md$/i.test(entry.name)) {
      const head = await readHead(ctx, full)
      // 平铺文件也走受 maxDirBytes 约束的大小统计，避免单文件突破上限
      const sizeBytes = await measureDir(ctx, full, `skill file ${full}`)
      const real = await realpathOr(ctx, full)
      skills.push({
        name: frontmatterName(head) || entry.name.replace(/\.md$/i, ''),
        path: full,
        root: root.path,
        source: root.source,
        isDirectory: false,
        sizeBytes,
        external: !isInside(ctx.profileReal, real),
      })
    }
  }
  return skills
}

async function scanSkills(ctx, workspaces) {
  const rawRoots = [
    { path: path.join(ctx.dshHome, 'skills'), source: 'user-dsh' },
    { path: path.join(ctx.homeDir, '.agents', 'skills'), source: 'user-agents' },
  ]
  for (const workspace of workspaces) {
    rawRoots.push({ path: path.join(workspace.path, '.dsh', 'skills'), source: 'workspace-dsh' })
    rawRoots.push({ path: path.join(workspace.path, '.agents', 'skills'), source: 'workspace-agents' })
  }

  const skillRoots = []
  const skills = []
  const seenRoots = new Set()
  for (const root of rawRoots) {
    throwIfAborted(ctx.signal)
    const key = path.resolve(root.path)
    if (seenRoots.has(key)) continue
    seenRoots.add(key)
    const st = await statSafe(ctx, root.path)
    const exists = Boolean(st && st.isDirectory())
    const found = exists ? await scanSkillRoot(ctx, root) : []
    skills.push(...found)
    skillRoots.push({ path: root.path, source: root.source, exists, count: found.length })
  }
  return { skills, skillRoots }
}

/* ------------------------------------------------------------------ */
/* 外部候选 / 排除项 / 版本                                            */
/* ------------------------------------------------------------------ */

async function collectExternalCandidates(ctx, plugins, skillRoots) {
  const deps = profileDependencies(ctx.profilePackage)
  const candidates = new Map() // path -> {path, why, kind}
  const add = (target, why, kind) => {
    if (!target) return
    const abs = path.resolve(target)
    if (!candidates.has(abs)) candidates.set(abs, { path: abs, why, kind })
  }

  // 1) profile 依赖里的 file: 本地插件来源（realpath 在 profile 外）
  for (const [name, spec] of Object.entries(deps)) {
    throwIfAborted(ctx.signal)
    if (ctx.pluginPackageName && name === ctx.pluginPackageName) continue // 备份插件自身
    const target = resolveFileSpec(ctx, spec)
    if (!target) continue
    const st = await statSafe(ctx, target)
    if (!st) {
      warn(ctx, `本地插件来源不存在: ${target}`)
      continue
    }
    const real = await realpathOr(ctx, target)
    if (!isInside(ctx.profileReal, real)) add(real, 'local plugin link target', 'plugin')
  }

  // 2) node_modules 里的符号链接目标（profile 外才记录）
  for (const plugin of plugins) {
    throwIfAborted(ctx.signal)
    if (plugin.linkTarget && !isInside(ctx.profileReal, plugin.linkTarget)) {
      add(plugin.linkTarget, 'local plugin link target', 'plugin')
    }
    if (plugin.packageDir) {
      const real = await realpathOr(ctx, plugin.packageDir)
      if (!isInside(ctx.profileReal, real)) {
        add(real, 'local plugin link target', 'plugin')
      }
    }
  }

  // 3) $DSH_HOME 一级目录：插件运行时数据目录（排除 DSH 内部项）
  try {
    const entries = await fsp.readdir(ctx.dshHome, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      if (INTERNAL_HOME_NAMES.has(entry.name)) continue
      let kind = entry
      if (entry.isSymbolicLink()) {
        kind = await statSafe(ctx, path.join(ctx.dshHome, entry.name))
        if (!kind) continue
      }
      if (!kind.isDirectory()) continue
      add(path.join(ctx.dshHome, entry.name), 'plugin data dir', 'data')
    }
  } catch (err) {
    if (!isMissing(err)) warn(ctx, `无法读取 $DSH_HOME 目录: ${fmtErr(err)}`)
  }

  // 4) workspace 里的 skill 根（外部文件，需要用户/AI 判断是否打包）
  for (const root of skillRoots) {
    if (!root.exists) continue
    if (root.source !== 'workspace-dsh' && root.source !== 'workspace-agents') continue
    add(root.path, 'workspace skill root', 'skill')
  }

  return [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** 备份插件自身的安装位置（file: 来源或 node_modules 目录），用于 excluded */
async function findSelfPackageDir(ctx) {
  if (!ctx.pluginPackageName) return null
  const deps = profileDependencies(ctx.profilePackage)
  const target = resolveFileSpec(ctx, deps[ctx.pluginPackageName])
  if (target && (await statSafe(ctx, target))) return target
  const dir = path.join(ctx.profileDir, 'node_modules', ctx.pluginPackageName)
  if (await isDirectory(ctx, dir)) return dir
  return null
}

async function collectExcluded(ctx, selfPackageDir) {
  const specs = [
    [path.join(ctx.dshHome, '.credentials.yaml'), '凭证文件，禁止读取与打包'],
    [path.join(ctx.dshHome, '.anonymous-user-id'), '本机匿名标识，不打包'],
    [path.join(ctx.dshHome, 'sessions'), 'DSH 会话数据，不打包'],
    [path.join(ctx.dshHome, 'storages'), 'DSH 存储数据，不打包'],
    [path.join(ctx.profileDir, '.plugin-manager'), '插件安装日志与缓存，不打包'],
    [path.join(ctx.profileDir, 'node_modules', '.cache'), 'node_modules 缓存，不打包'],
  ]
  if (ctx.installationNodeModules) {
    // runner 传入的是 <runtimeDir>/node_modules：上一级即 DSH 安装目录
    specs.push([
      path.resolve(ctx.installationNodeModules, '..'),
      'DSH 安装目录，不打包（恢复说明中注明依赖该版本）',
    ])
  }
  if (selfPackageDir) specs.push([selfPackageDir, '备份插件自身，不打包'])

  const out = []
  const seen = new Set()
  for (const [target, why] of specs) {
    throwIfAborted(ctx.signal)
    if (!target || seen.has(target)) continue
    seen.add(target)
    const st = await lstatSafe(ctx, target)
    if (!st) continue
    out.push({ path: target, why })
  }
  return out
}

async function detectDshVersion(ctx) {
  const candidates = []
  if (ctx.installationNodeModules) {
    candidates.push(path.join(ctx.installationNodeModules, '@deepseek-ai', 'dsh', 'package.json'))
    candidates.push(path.join(ctx.installationNodeModules, 'dsh', 'package.json'))
    candidates.push(
      path.join(ctx.installationNodeModules, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    )
  }
  try {
    const requireFromProfile = createRequire(path.join(ctx.profileDir, 'package.json'))
    candidates.push(requireFromProfile.resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    /* 解析不到就靠 installationNodeModules */
  }
  for (const file of candidates) {
    if (!file) continue
    const pkg = await readJsonSafe(ctx, file)
    if (pkg && typeof pkg.version === 'string' && pkg.version) return pkg.version
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 扫描 DSH 安装项。
 * @param {object} opts
 * @param {string} opts.dshHome                    // $DSH_HOME
 * @param {string} opts.profileDir                 // $DSH_HOME/profiles/<profile>
 * @param {string} opts.profileName
 * @param {string} [opts.homeDir]                  // os.homedir()
 * @param {Array}  [opts.bundles]                  // pluginManager.listBundles() 结果（不可用时 undefined）
 * @param {Array}  [opts.workspaces]               // [{id,path,title}] 来自 workspaceRegistry.list()
 * @param {string} [opts.pluginPackageName]        // 'dsh-backup-all'，用于排除自身
 * @param {string} [opts.installationNodeModules]  // <runtimeDir>/node_modules，用于解析 installation 包目录
 * @param {number} [opts.maxDirBytes]              // 单目录大小统计上限，默认 200MB
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} Inventory（字段见 docs/MODULE-CONTRACTS.md B 节）
 */
export async function scanInventory(opts = {}) {
  throwIfAborted(opts.signal)
  const ctx = createContext(opts || {})

  // profile package.json 是后续 bundle / plugin / 补丁推断的锚点
  ctx.profilePackage = await readJsonSafe(ctx, path.join(ctx.profileDir, 'package.json'))
  ctx.profileReal = await realpathOr(ctx, ctx.profileDir)
  throwIfAborted(ctx.signal)

  const workspaces = normalizeWorkspaces(opts.workspaces)
  const enabledNames = profileBundleNames(ctx.profilePackage)

  // 1) bundle 清单（服务数据优先，缺失时文件兜底）
  const bundleMetas = await buildBundles(ctx, opts, enabledNames)
  throwIfAborted(ctx.signal)

  // 2) 补丁 YAML 行扫描：profile 补丁 + 首页补丁 + 每个 bundle 的补丁文件
  const patchFiles = []
  const seenPatchFiles = new Set()
  const pushPatchFile = (file) => {
    if (!file) return
    const abs = path.resolve(file)
    if (seenPatchFiles.has(abs)) return
    seenPatchFiles.add(abs)
    patchFiles.push(abs)
  }
  pushPatchFile(path.join(ctx.profileDir, 'cordis.patch.yml'))
  pushPatchFile(path.join(ctx.dshHome, 'cordis.patch.yml'))
  for (const meta of bundleMetas) for (const file of meta.patchFiles) pushPatchFile(file)

  const patchRows = []
  for (const file of patchFiles) {
    throwIfAborted(ctx.signal)
    const text = await readTextSafe(ctx, file)
    if (text === null) continue // 不存在的补丁文件静默跳过（configFiles 里能看出存在性）
    patchRows.push(...scanPatchText(text, file))
  }

  // 补丁行分类：先按 name 显式识别，再按「已知行的 id」识别覆盖行（只写 id+config 的 patch）。
  // 用户从 Web 编辑器保存的 preset / MCP 配置常是按 id override 的行，不能漏。
  const classifiedKinds = patchRows.map((row) => classifyModuleName(row.name))
  const mcpRowIds = new Set()
  const presetRowIds = new Set()
  const presetRegistryRowIds = new Set([
    'agent-preset-registry', // dsh-web-app 内置 preset registry 行的 id
    'dsh-agent-preset-registry',
  ])
  classifiedKinds.forEach((kind, index) => {
    if (!kind) return
    if (kind === 'mcp') mcpRowIds.add(patchRows[index].id)
    else if (kind === 'preset') presetRowIds.add(patchRows[index].id)
    else presetRegistryRowIds.add(patchRows[index].id)
  })

  const mcpRows = []
  const presetRows = []
  const presetRegistryRows = []
  patchRows.forEach((row, index) => {
    let kind = classifiedKinds[index]
    if (!kind) {
      if (presetRegistryRowIds.has(row.id)) kind = 'preset-registry'
      else if (presetRowIds.has(row.id)) kind = 'preset'
      else if (mcpRowIds.has(row.id)) kind = 'mcp'
    }
    if (!kind) return
    const moduleName =
      row.name ||
      (kind === 'mcp' ? MCP_MODULE : kind === 'preset' ? PRESET_MODULE : PRESET_REGISTRY_MODULE)
    const publicRow = {
      file: row.file,
      rowId: row.id,
      name: moduleName,
      configText: row.configText,
    }
    if (kind === 'mcp') mcpRows.push(publicRow)
    else if (kind === 'preset') presetRows.push(publicRow)
    else presetRegistryRows.push(publicRow)
  })

  // 3) 插件包 / Skill / 外部候选 / 排除项
  const plugins = await scanPlugins(ctx, bundleMetas)
  throwIfAborted(ctx.signal)
  const { skills, skillRoots } = await scanSkills(ctx, workspaces)
  throwIfAborted(ctx.signal)
  const externalCandidates = await collectExternalCandidates(ctx, plugins, skillRoots)
  throwIfAborted(ctx.signal)
  const selfPackageDir = await findSelfPackageDir(ctx)
  const excluded = await collectExcluded(ctx, selfPackageDir)
  const dshVersion = await detectDshVersion(ctx)
  throwIfAborted(ctx.signal)

  // 4) 组装：字段名严格按契约 B
  return {
    generatedAt: new Date().toISOString(),
    dshHome: ctx.dshHome,
    profileDir: ctx.profileDir,
    profileName: ctx.profileName,
    dshVersion,
    configFiles: await scanConfigFiles(ctx),
    bundles: publicBundles(bundleMetas, patchRows),
    plugins,
    patchRows,
    mcpRows,
    presetRows,
    presetRegistryRows,
    skills,
    skillRoots,
    externalCandidates,
    excluded,
    warnings: ctx.warnings,
  }
}
