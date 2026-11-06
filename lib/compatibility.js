/**
 * lib/compatibility.js —— 恢复兼容性矩阵（契约 §3）。
 *
 * 纯函数：给定快照环境与当前环境，返回 compatibility 对象。
 * 调用方（tools-restore）据此强制执行 restrictions。
 *
 * 矩阵：
 *   linux→linux     → full                same-linux      supported
 *   windows→windows → full-windows        same-windows    supported
 *   linux→windows   → compat-linux-to-windows  linux-to-windows  supported
 *   windows→linux   → compat-windows-to-linux  windows-to-linux  兼容恢复
 *   unknown→任意     → compat-linux-to-windows（保守兼容）
 *   other→other     → full（当作同 OS）
 *   other→不同       → compat-linux-to-windows（保守兼容）
 */

import { detectOsType, OS_LINUX, OS_WINDOWS, OS_OTHER, isKnownOsType } from './platform.js'

/** @typedef {'same-linux'|'same-windows'|'linux-to-windows'|'windows-to-linux'|'unknown'} CompatMode */
/** @typedef {'full'|'full-windows'|'compat-linux-to-windows'|'compat-windows-to-linux'|'blocked'} CompatStrategy */
/** @typedef {'skip-plugin-code'|'plugin-code-js-only'|'skip-symlinks'|'reinstall-registry-only'} Restriction */

/**
 * @param {object} snapshotEnv  manifest.environment（可能缺字段/为 null）
 * @param {object} currentEnv   当前运行环境
 * @returns {{
 *   snapshotOs: string,
 *   currentOs: string,
 *   mode: CompatMode,
 *   supported: boolean,
 *   strategy: CompatStrategy,
 *   restrictions: Restriction[],
 *   notes: string[]
 * }}
 */
export function buildCompatibility(snapshotEnv, currentEnv, options = {}) {
  const snapshotOs = normalizeOs(snapshotEnv?.osType)
  const currentOs = normalizeOs(currentEnv?.osType ?? detectOsType())

  const mode = deriveMode(snapshotOs, currentOs)
  // 用户可选的跨 OS 增强：迁移纯 JS 插件代码（默认跳过）
  const migrateJs = options && (options.crossOsPluginCode === 'js' || options.jsPluginCode === true)

  let supported = true
  let strategy = 'full'
  /** @type {Restriction[]} */
  const restrictions = []
  /** @type {string[]} */
  const notes = []

  if (snapshotOs === OS_LINUX && currentOs === OS_LINUX) {
    // linux → linux：完整恢复
    strategy = 'full'
  } else if (snapshotOs === OS_WINDOWS && currentOs === OS_WINDOWS) {
    // windows → windows：完整恢复，但 junction/symlink 降级、ACL 替代 0600
    strategy = 'full-windows'
  } else if (snapshotOs === OS_LINUX && currentOs === OS_WINDOWS) {
    // linux → windows：兼容恢复
    strategy = 'compat-linux-to-windows'
    if (migrateJs) restrictions.push('plugin-code-js-only', 'skip-symlinks', 'reinstall-registry-only')
    else restrictions.push('skip-plugin-code', 'skip-symlinks', 'reinstall-registry-only')
    notes.push(
      '跨 OS：Linux 插件代码/原生模块不可直接用于 Windows；profiles 插件按来源重装',
      'symlink 条目已跳过；外部绝对路径已 fallback 到 DSH_HOME/restore-external/<文件名>',
      '跨 OS 恢复完成后需在 Windows 上重装 profile 依赖（dsh plugin --profile <name> install）',
    )
    if (migrateJs) notes.push('已启用「迁移纯 JS 插件代码」：Host 只写回通过纯 JS 校验的 plugin-code；含原生二进制/平台限制的条目跳过并写 warnings')
  } else if (snapshotOs === OS_WINDOWS && currentOs === OS_LINUX) {
    // windows → linux：兼容恢复（与 linux→windows 对称；不写回 Windows 插件代码/符号链接）
    strategy = 'compat-windows-to-linux'
    if (migrateJs) restrictions.push('plugin-code-js-only', 'skip-symlinks', 'reinstall-registry-only')
    else restrictions.push('skip-plugin-code', 'skip-symlinks', 'reinstall-registry-only')
    notes.push(
      '跨 OS：Windows 插件代码/原生二进制不可直接用于 Linux；registry 插件按来源重装',
      'Windows 的 link:/file: 绝对路径依赖会被移除，需在 Linux 重新获取源码并安装',
      '符号链接/junction 条目已跳过；Windows 绝对外部路径 fallback 到 <DSH_HOME>/restore-external',
      '依赖安装使用 Linux 的 dsh/pnpm 命令',
    )
    if (migrateJs) notes.push('已启用「迁移纯 JS 插件代码」：Host 只写回通过纯 JS 校验的 plugin-code；含原生二进制/平台限制的条目跳过并写 warnings')
  } else {
    // other / unknown / 混合：保守兼容
    strategy = 'compat-linux-to-windows'
    if (migrateJs) restrictions.push('plugin-code-js-only', 'skip-symlinks', 'reinstall-registry-only')
    else restrictions.push('skip-plugin-code', 'skip-symlinks', 'reinstall-registry-only')
    notes.push(
      `保守兼容模式（快照 OS=${snapshotOs}，当前 OS=${currentOs}）：按跨 OS 策略处理`,
      migrateJs ? '已启用纯 JS 插件代码迁移（Host 逐个校验）' : '插件代码不写回、symlink 跳过、registry 插件按来源重装',
    )
  }

  return {
    snapshotOs,
    currentOs,
    mode,
    supported,
    strategy,
    restrictions,
    notes,
  }
}

/* ------------------------------------------------------------------ */
/* 内部                                                                */
/* ------------------------------------------------------------------ */

function normalizeOs(value) {
  const t = String(value ?? '').toLowerCase().trim()
  if (isKnownOsType(t)) return t
  // 老快照没有 osType → unknown
  return 'unknown'
}

function deriveMode(snapshotOs, currentOs) {
  if (snapshotOs === OS_LINUX && currentOs === OS_LINUX) return 'same-linux'
  if (snapshotOs === OS_WINDOWS && currentOs === OS_WINDOWS) return 'same-windows'
  if (snapshotOs === OS_LINUX && currentOs === OS_WINDOWS) return 'linux-to-windows'
  if (snapshotOs === OS_WINDOWS && currentOs === OS_LINUX) return 'windows-to-linux'
  return 'unknown'
}