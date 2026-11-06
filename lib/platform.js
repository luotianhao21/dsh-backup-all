// dsh-backup-all · 跨平台事实（OS 类型、文件名、命令执行、路径比较）
//
// 设计目标：同一份插件在 Linux / Windows 上都能创建、导入、恢复快照：
//   - 快照记录与文件名带 osType（linux / windows / other），供恢复时选择策略；
//   - Windows 上通过 cmd.exe 解析 dsh.cmd / pnpm.cmd（execFile 直接调用会 ENOENT）；
//   - Windows 路径大小写不敏感：比较/前缀判断统一 lowercase；
//   - 权限 0600 只在类 Unix 生效（Windows 用 ACL，需要提示而非报错）。
//
// 这里不 import 任何 Node 之外的东西，纯函数 + 极少 child_process，便于单测注入 platform。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve as pathResolve, win32 as pathWin32 } from 'node:path'

const execFileAsync = promisify(execFile)

export const OS_LINUX = 'linux'
export const OS_WINDOWS = 'windows'
export const OS_OTHER = 'other'

export const OS_TOKENS = [OS_LINUX, OS_WINDOWS, OS_OTHER]

/** process.platform → 快照里记录的 osType（linux / windows / other） */
export function detectOsType(platform = process.platform) {
  if (platform === 'linux') return OS_LINUX
  if (platform === 'win32') return OS_WINDOWS
  return OS_OTHER
}

/** 由名字/文件名里猜 osType（导入旧文件/缺 manifest 时用） */
export function osTypeFromName(text) {
  const s = String(text || '').toLowerCase()
  if (/(?:^|[.\-_ ])linux(?:[.\-_ ]|$)/.test(s)) return OS_LINUX
  if (/(?:^|[.\-_ ])windows(?:[.\-_ ]|$)/.test(s)) return OS_WINDOWS
  if (/(?:^|[.\-_ ])other(?:[.\-_ ]|$)/.test(s)) return OS_OTHER
  return null
}

export function isKnownOsType(value) {
  return OS_TOKENS.includes(String(value || '').toLowerCase())
}

/** 展示名（UI/日志用；生成器写英文 token，不写中文进文件名） */
export function osLabel(osType) {
  const t = String(osType || '').toLowerCase()
  if (t === OS_LINUX) return 'Linux'
  if (t === OS_WINDOWS) return 'Windows'
  if (t === OS_OTHER) return 'Other'
  return '未知'
}

/** 文件名主干：2026-11-06 10-30-00-linux.backup.tar.br */
export function snapshotFileBase(stamp, osType) {
  const token = isKnownOsType(osType) ? String(osType).toLowerCase() : OS_OTHER
  return String(stamp || '') + '-' + token
}

export function snapshotFileName(stamp, osType, ext = '.backup.tar.br') {
  return snapshotFileBase(stamp, osType) + ext
}

/** Windows 保留文件名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）与非法字符清理，用于导入文件名兜底 */
export function sanitizeFileStem(name, fallback = 'snapshot') {
  let stem = String(name || '')
    .replace(/[\u0000-\u001f]/g, '')
    .split(/[\\/]/)
    .pop() || ''
  stem = stem.replace(/[<>:"|?*]/g, '-').trim().replace(/[. ]+$/g, '')
  if (!stem) stem = fallback
  const base = stem.split('.')[0].toUpperCase()
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base)) stem = '_' + stem
  return stem.slice(0, 120) || fallback
}

/** 权限语义是否生效（0600 仅类 Unix；Windows 忽略 mode） */
export function permissionModeSupported(platform = process.platform) {
  return platform !== 'win32'
}

/** 路径比较键：Windows 大小写不敏感；剥离 \\?\ 前缀；统一分隔符 */
export function pathCompareKey(p, platform = process.platform) {
  let s = String(p || '')
  if (platform === 'win32') {
    s = s.replace(/^\\\\\?\\/, '').replace(/\//g, '\\')
    return pathWin32.resolve(s).toLowerCase()
  }
  return pathResolve(s)
}

/** Windows 命令行参数安全引用（cmd.exe /c 下） */
export function quoteCmdArg(arg) {
  const s = String(arg)
  if (s === '') return '""'
  if (!/[\s"&|<>^()%!]/.test(s)) return s
  return '"' + s.replace(/(["])/g, '\\$1').replace(/%/g, '%%') + '"'
}

/**
 * 执行命令（跨平台）：Windows 上通过 cmd.exe /d /s /c 解析 dsh.cmd / pnpm.cmd。
 * @param {string} cmd 例如 'dsh'
 * @param {string[]} args
 * @param {{cwd?:string,timeoutMs?:number,env?:object,signal?:AbortSignal,maxBuffer?:number,platform?:string}} options
 * @returns {Promise<{stdout:string,stderr:string}>}
 */
export async function runCommand(cmd, args = [], options = {}) {
  const platform = options.platform || process.platform
  const maxBuffer = options.maxBuffer || 16 * 1024 * 1024
  const runOpts = {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer,
    env: options.env || process.env,
    signal: options.signal,
    windowsHide: true,
  }
  if (platform === 'win32') {
    const line = [cmd, ...args].map(quoteCmdArg).join(' ')
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
    return execFileAsync(comspec, ['/d', '/s', '/c', line], runOpts)
  }
  return execFileAsync(cmd, args, runOpts)
}

/** 判断某个错误是否属于「命令不存在」（跨平台） */
export function isCommandMissing(error) {
  if (!error) return false
  const code = String(error.code || '')
  const msg = String(error.message || '')
  return code === 'ENOENT' || /ENOENT|not recognized|不是内部或外部命令|CommandNotFoundException/i.test(msg)
}
