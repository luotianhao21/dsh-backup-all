// dsh-backup-all · 路径与运行环境事实
//
// 这里集中回答「东西都在哪」：DSH_HOME、profile 目录、插件自己的目录、备份/数据目录，
// 以及把绝对路径编码成可跨机器恢复的占位符形式（$DSH_HOME / $DSH_PROFILE_DIR / $WORKSPACE:<name>）。
// 设计原则：不依赖任何 Host 服务，纯 Node 就能解析；服务不可用时也能跑。

import { homedir, arch as osArch, release as osRelease } from 'node:os'
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync as requireExists } from 'node:fs'
import { createHash } from 'node:crypto'
import { detectOsType, snapshotFileName as platformSnapshotFileName, pathCompareKey } from './platform.js'

export const PLUGIN_ID = 'dsh-backup-all'

// import.meta.url 指向 lib/ 下的本文件；插件根 = 上一级。
// 注意：install_bundle 以 file: 安装时 node_modules 里是符号链接，Node 会解析成真实路径，
// 所以这里得到的就是仓库工作目录（插件“本体文件夹”）。
export const PLUGIN_ROOT = dirname(fileURLToPath(new URL('../index.js', import.meta.url)))

/** 解析一次运行环境。所有字段都是绝对路径（除了名字/版本）。 */
export function resolveEnv(overrides = {}) {
  const dshHome = overrides.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const profileName = overrides.profileName || process.env.DSH_PROFILE || 'web'
  const profileDir = overrides.profileDir || process.env.DSH_PROFILE_DIR || join(dshHome, 'profiles', profileName)
  const backupDir = overrides.backupDir || join(PLUGIN_ROOT, 'backup')
  const dataDir = overrides.dataDir || join(PLUGIN_ROOT, 'data')
  const platform = overrides.platform || process.platform
  return {
    dshHome,
    homeDir: overrides.homeDir || homedir(),
    profileName,
    profileDir,
    pluginRoot: PLUGIN_ROOT,
    backupDir,
    dataDir,
    cacheDir: join(backupDir, '.cache'),
    recordsFile: join(dataDir, 'records.json'),
    settingsFile: join(dataDir, 'settings.json'),
    homePatchFile: join(dshHome, 'cordis.patch.yml'),
    credentialsFile: join(dshHome, '.credentials.yaml'),
    pluginGuardFile: join(dshHome, 'dshbox', 'plugin-guard.json'),
    legacyPresetDir: join(dshHome, '.agent-presets'),
    nodeVersion: process.version,
    platform,
    osType: overrides.osType || detectOsType(platform),
    arch: overrides.arch || osArch(),
    osRelease: overrides.osRelease || osRelease(),
  }
}

/** true 表示 child 在 parent 之内（含相等）。用于安全校验与占位符编码。 */
export function isInside(parent, child) {
  if (!parent || !child) return false
  // Windows：大小写不敏感 + 盘符/分隔符归一；Linux：resolve 原样比较
  const p = pathCompareKey(parent)
  const c = pathCompareKey(child)
  if (p === c) return true
  const sepChar = process.platform === 'win32' ? '\\' : sep
  return c.startsWith(p.endsWith(sepChar) ? p : p + sepChar)
}

/** workspace 目录名比较（Windows 大小写不敏感） */
function baseEquals(a, b) {
  return process.platform === 'win32'
    ? String(a).toLowerCase() === String(b).toLowerCase()
    : String(a) === String(b)
}

/**
 * 把绝对路径编码成恢复侧可重定位的目标串：
 *   $DSH_PROFILE_DIR/…       profile 目录内
 *   $DSH_HOME/…              DSH 家目录内（profile 之外）
 *   $WORKSPACE:<name>/…      某个工作区内（name 来自 workspaceRegistry）
 *   绝对路径                 其它外部路径（原样）
 */
export function encodeTargetPath(absPath, env, workspaces = []) {
  if (!absPath || !isAbsolute(absPath)) return String(absPath || '')
  const p = resolve(absPath)
  // profile 必须先判定：它在 DSH_HOME 里面，顺序反了会被粗粒度占位符吃掉
  if (env?.profileDir && isInside(env.profileDir, p)) {
    return '$DSH_PROFILE_DIR' + (p === resolve(env.profileDir) ? '' : '/' + relative(env.profileDir, p).split(sep).join('/'))
  }
  if (env?.dshHome && isInside(env.dshHome, p)) {
    return '$DSH_HOME' + (p === resolve(env.dshHome) ? '' : '/' + relative(env.dshHome, p).split(sep).join('/'))
  }
  for (const ws of workspaces || []) {
    if (ws && ws.path && isInside(ws.path, p)) {
      const name = ws.name || ws.title || ws.id || 'workspace'
      return '$WORKSPACE:' + String(name).replace(/[\s/]+/g, '-') +
        (p === resolve(ws.path) ? '' : '/' + relative(ws.path, p).split(sep).join('/'))
    }
  }
  return p
}

/** encodeTargetPath 的逆运算。$WORKSPACE: 解析不到时返回 null（恢复说明里让人工映射）。 */
export function decodeTargetPath(encoded, env, workspaces = []) {
  const s = String(encoded || '')
  if (s.startsWith('$DSH_PROFILE_DIR')) {
    const rest = s.slice('$DSH_PROFILE_DIR'.length).replace(/^[/\\]/, '')
    return rest ? join(env.profileDir, ...rest.split('/')) : env.profileDir
  }
  if (s.startsWith('$DSH_HOME')) {
    const rest = s.slice('$DSH_HOME'.length).replace(/^[/\\]/, '')
    return rest ? join(env.dshHome, ...rest.split('/')) : env.dshHome
  }
  if (s.startsWith('$WORKSPACE:')) {
    const tail = s.slice('$WORKSPACE:'.length)
    const slash = tail.indexOf('/')
    const name = slash === -1 ? tail : tail.slice(0, slash)
    const rest = slash === -1 ? '' : tail.slice(slash + 1)
    const ws = (workspaces || []).find((w) => {
      const n = String((w && (w.name || w.title || w.id)) || '').replace(/[\s/]+/g, '-')
      return n === name
    })
    if (!ws) return null
    return rest ? join(ws.path, ...rest.split('/')) : ws.path
  }
  return isAbsolute(s) ? s : null
}

/** 把路径压成给用户/日志看的短形式（$DSH_HOME/… 形式），不影响恢复逻辑。 */
/** 把一段路径变成安全单段名（用于重映射兜底目录） */
export function sanitizeSegment(text) {
  return String(text || '')
    .replace(/[^\w.\-\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item'
}

function basenameOf(p) {
  try {
    return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  } catch {
    return ''
  }
}

function normalizeWorkspaceName(ws) {
  return String((ws && (ws.name || ws.title || ws.id)) || '').replace(/[\s/\\]+/g, '-')
}

/**
 * 更强的自动路径重映射（跨机器恢复用）。
 *
 * 优先级：
 *  1. 占位符目标（$DSH_HOME / $DSH_PROFILE_DIR / $WORKSPACE:<name>）直接按当前环境解码；
 *     $WORKSPACE 名字对不上时，再按「旧 workspace 名 → basename → 当前 workspace」匹配；
 *  2. 外部绝对路径：本机已存在则原样使用；否则按旧环境根前缀重映射
 *     （旧 homeDir / 旧 dshHome / 旧 profileDir / 旧 workspace 路径）；
 *  3. 仍无法映射时，落到 <当前 DSH_HOME>/restore-external/<安全路径>，保证恢复可继续且可审计；
 *  4. 所有重映射都返回 original + reason，便于恢复 AI 在摘要里如实报告。
 *
 * @returns {{ok:true, target:string, remapped:boolean, mode:string, original:string, reason?:string}
 *         | {ok:false, target:null, remapped:false, mode:'unmapped', original:string, reason:string}}
 */
export function resolveRestoreTarget(entry, manifestEnvironment, env, workspaces = []) {
  const encoded = String((entry && entry.target) || '')
  const source = String((entry && entry.source) || '')
  const oldEnv = manifestEnvironment || {}
  const oldWorkspaces = Array.isArray(oldEnv.workspaces) ? oldEnv.workspaces : []
  const currentWorkspaces = workspaces || []

  const allowedFinal = (target, allowHome = false) => {
    if (!target) return false
    const roots = [env.dshHome, env.profileDir]
    for (const ws of currentWorkspaces) if (ws && ws.path) roots.push(ws.path)
    if (roots.some((root) => root && isInside(root, target))) return true
    // 外部文件：目标与快照记录的原位置一致时允许写回原处
    if (source && target === source) return true
    // 仅「旧 homeDir 前缀 → 当前 homeDir」这种保持相对位置的重映射允许落在用户 home 下
    if (allowHome && env.homeDir && isInside(env.homeDir, target)) return true
    return false
  }

  // 1) 占位符
  if (/^\$/.test(encoded)) {
    let target = decodeTargetPath(encoded, env, currentWorkspaces)
    if (target) {
      if (!allowedFinal(target)) {
        return { ok: false, target: null, remapped: false, mode: 'unmapped', original: encoded, reason: '占位符解码结果不在允许恢复的目录内' }
      }
      return { ok: true, target, remapped: false, mode: 'placeholder', original: encoded }
    }
    // $WORKSPACE:<name> 名字对不上：用旧 workspace 的 path basename 找当前同名/同 basename 的 workspace
    const raw = encoded.replace(/^\$WORKSPACE:/, '')
    const slash = raw.indexOf('/')
    const oldName = slash === -1 ? raw : raw.slice(0, slash)
    const rest = slash === -1 ? '' : raw.slice(slash + 1)
    const oldWs = oldWorkspaces.find((ws) => normalizeWorkspaceName(ws) === oldName)
    const oldBase = oldWs && oldWs.path ? basenameOf(oldWs.path) : oldName
    const match = currentWorkspaces.find((ws) => normalizeWorkspaceName(ws) === oldName)
      || currentWorkspaces.find((ws) => ws && ws.path && baseEquals(basenameOf(ws.path), oldBase))
    if (match) {
      const target = rest ? join(match.path, ...rest.split('/')) : match.path
      if (allowedFinal(target)) {
        return { ok: true, target, remapped: true, mode: 'workspace-remap', original: encoded, reason: '工作区按名称/目录名重映射到 ' + match.path }
      }
    }
    // 跨 OS 时旧 workspace 通常不存在：落到 restore-external，保证可审计而不是静默跳过
    const crossOs = Boolean(oldEnv.osType && env.osType && String(oldEnv.osType).toLowerCase() !== String(env.osType).toLowerCase())
    if (crossOs) {
      const hash = createHash('sha1').update(encoded).digest('hex').slice(0, 8)
      const leaf = sanitizeSegment(oldName || 'workspace')
      const base = join(env.dshHome, 'restore-external', leaf + '-' + hash)
      const segments = String(rest || '').split('/').filter(Boolean).map((seg) => sanitizeSegment(seg))
      const target = segments.length ? join(base, ...segments) : base
      if (allowedFinal(target)) {
        return { ok: true, target, remapped: true, mode: 'fallback', original: encoded, reason: '跨 OS：旧工作区 ' + oldName + ' 不存在，已落到 <DSH_HOME>/restore-external/' + leaf + '-' + hash }
      }
    }
    return { ok: false, target: null, remapped: false, mode: 'unmapped', original: encoded, reason: '找不到同名/同目录名的工作区，无法映射 $WORKSPACE:' + oldName }
  }

  // 非绝对路径（不应出现）：当作不可映射；跨 OS 的 Windows 盘符路径（在 Linux 上 isAbsolute=false）走 fallback
  if (!isAbsolute(encoded)) {
    const crossOs = Boolean(oldEnv.osType && env.osType && String(oldEnv.osType).toLowerCase() !== String(env.osType).toLowerCase())
    if (crossOs && /^[A-Za-z]:[\\/]/.test(encoded)) {
      const hash = createHash('sha1').update(encoded).digest('hex').slice(0, 8)
      const leaf = sanitizeSegment(basenameOf(encoded) || 'item')
      const target = join(env.dshHome, 'restore-external', leaf + '-' + hash)
      if (allowedFinal(target)) {
        return { ok: true, target, remapped: true, mode: 'fallback', original: encoded, reason: '跨 OS：Windows 绝对路径在 Linux 无对应位置，已落到 <DSH_HOME>/restore-external/' + leaf + '-' + hash }
      }
    }
    return { ok: false, target: null, remapped: false, mode: 'unmapped', original: encoded, reason: '目标不是绝对路径也不是占位符' }
  }

  // 2) 外部绝对路径：本机存在且与原位置一致 → 原样
  if (targetExists(encoded) && (encoded === source || allowedFinal(encoded))) {
    return { ok: true, target: encoded, remapped: false, mode: 'absolute', original: encoded }
  }

  // 3) 按旧环境根前缀重映射
  // 从具体到宽泛：先 profileDir，再 dshHome；workspace 之前命中；homeDir 放最后（最宽前缀，避免吃掉 workspace）
  const roots = [
    ['profileDir', oldEnv.profileDir, env.profileDir],
    ['dshHome', oldEnv.dshHome, env.dshHome],
  ]
  for (const [name, oldRoot, newRoot] of roots) {
    if (!oldRoot || !newRoot) continue
    if (isInside(oldRoot, encoded)) {
      const rel = relative(oldRoot, encoded).split(sep).join('/')
      const target = join(newRoot, ...rel.split('/'))
      if (allowedFinal(target)) {
        return { ok: true, target, remapped: true, mode: name + '-remap', original: encoded, reason: '旧 ' + name + ' 前缀重映射到当前 ' + name }
      }
    }
  }
  for (const oldWs of oldWorkspaces) {
    if (!oldWs || !oldWs.path) continue
    if (!isInside(oldWs.path, encoded)) continue
    const oldBase = basenameOf(oldWs.path)
    const match = currentWorkspaces.find((ws) => ws && ws.path && baseEquals(basenameOf(ws.path), oldBase))
    if (!match) continue
    const rel = relative(oldWs.path, encoded).split(sep).join('/')
    const target = join(match.path, ...rel.split('/'))
    if (allowedFinal(target)) {
      return { ok: true, target, remapped: true, mode: 'workspace-remap', original: encoded, reason: '旧工作区目录按 basename 重映射到 ' + match.path }
    }
  }

  // 3b) 最后才尝试旧 homeDir 前缀（比 workspace 宽，放最后避免吃掉 workspace 特例）
  if (oldEnv.homeDir && env.homeDir && isInside(oldEnv.homeDir, encoded)) {
    const rel = relative(oldEnv.homeDir, encoded).split(sep).join('/')
    const target = join(env.homeDir, ...rel.split('/'))
    if (allowedFinal(target, true)) {
      return { ok: true, target, remapped: true, mode: 'homeDir-remap', original: encoded, reason: '旧 homeDir 前缀重映射到当前 homeDir' }
    }
  }

  // 4) 兜底：放到当前 DSH_HOME 下，便于用户/恢复 AI 审阅后手工移动。
  //    目录名带原路径短 hash，避免不同外部路径同名（如两个 tool-data）互相覆盖。
  const hash = createHash('sha1').update(encoded).digest('hex').slice(0, 8)
  const leaf = sanitizeSegment(basenameOf(encoded) || 'item')
  const fallback = join(env.dshHome, 'restore-external', leaf + '-' + hash)
  return {
    ok: true,
    target: fallback,
    remapped: true,
    mode: 'fallback',
    original: encoded,
    reason: '无法匹配旧路径，已落到 <DSH_HOME>/restore-external/' + leaf + '-' + hash + '（目录名含原路径短 hash），请在恢复摘要中提示用户确认是否移到原位置',
  }
}

/** 是否存在（文件/目录/符号链接均可） */
function targetExists(p) {
  try {
    return requireExists(p)
  } catch {
    return false
  }
}

export function displayPath(absPath, env) {
  return encodeTargetPath(absPath, env, [])
}

/** 时间戳 → 快照包名主干：2026-11-05 20-45-12 */
export function snapshotStamp(date = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0')
  return (
    date.getFullYear() + '-' + p2(date.getMonth() + 1) + '-' + p2(date.getDate()) +
    ' ' + p2(date.getHours()) + '-' + p2(date.getMinutes()) + '-' + p2(date.getSeconds())
  )
}

/** 默认快照名（创建弹窗的默认值）：{stamp}-{osType} */
export function defaultSnapshotName(date = new Date(), osType) {
  const stamp = snapshotStamp(date)
  const type = osType || detectOsType(process.platform)
  return stamp + '-' + type
}
