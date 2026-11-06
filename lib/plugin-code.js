// dsh-backup-all · 跨 OS 插件代码安全分类
//
// 用途：当用户启用「迁移纯 JS 插件代码」增强（settings.snapshot.crossOsPluginCode = 'js'）时，
// Host 在跨 OS 恢复中对每个 plugin-code 目录做保守分类：
//   - 只允许纯文本/JS 资源（无原生二进制、无平台专有脚本、无构建产物）；
//   - 读取 package.json 的 os/cpu/gypfile 声明，目标 OS 不匹配则拒绝；
//   - 文件数/总字节超限时保守拒绝；
// 分类通过才写回；否则跳过并写 warning（恢复摘要必须列出未恢复项）。
import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { extname, join } from 'node:path'

// 允许跨 OS 迁移的文件扩展名（全部为文本/通用图片/字体/源码）
const ALLOWED_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.markdown', '.txt',
  '.css', '.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.map', '.yml', '.yaml', '.toml', '.sh',
])

// 明确是原生/Windows 专有的文件（直接拒绝并列出）
const NATIVE_EXT = new Set(['.node', '.dll', '.so', '.dylib', '.exe', '.msi', '.lib', '.a', '.obj', '.pdb', '.bat', '.cmd', '.ps1'])

const DEFAULT_LIMITS = { maxFiles: 3000, maxBytes: 64 * 1024 * 1024 }

function normalizeOs(osType) {
  const t = String(osType || '').toLowerCase()
  if (t === 'linux') return 'linux'
  if (t === 'windows') return 'win32'
  return t || 'linux'
}

function normalizeArch(arch) {
  const t = String(arch || '').toLowerCase()
  return t === 'arm64' ? 'arm64' : 'x64'
}

/**
 * 判断一个已解包的插件代码目录是否可安全迁移到目标 OS。
 * @returns {{ pure: boolean, reason: string, fileCount: number, bytes: number, nativeFiles: string[], rejectedFiles: string[], declaredOs?: string[], declaredCpu?: string[] }}
 */
export function classifyPluginCodeDir(dir, { osType = 'linux', arch = process.arch, maxFiles, maxBytes } = {}) {
  const limits = { ...DEFAULT_LIMITS, maxFiles: maxFiles || DEFAULT_LIMITS.maxFiles, maxBytes: maxBytes || DEFAULT_LIMITS.maxBytes }
  const nativeFiles = []
  const rejectedFiles = []
  let fileCount = 0
  let bytes = 0
  let skipped = 0
  let declaredOs = null
  let declaredCpu = null
  let gypfile = false

  const reject = (reason) => ({ pure: false, reason, fileCount, bytes, nativeFiles, rejectedFiles, declaredOs: declaredOs || undefined, declaredCpu: declaredCpu || undefined })

  function walk(current) {
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch (e) { skipped += 1; return null }
    for (const ent of entries) {
      const abs = join(current, ent.name)
      let st
      try { st = lstatSync(abs) } catch { skipped += 1; continue }
      if (st.isSymbolicLink()) { rejectedFiles.push(rel(abs)); return { reason: '含符号链接（跨 OS 不安全）' } }
      if (st.isDirectory()) {
        // 跳过空缓存目录不必要；全部计入
        const r = walk(abs)
        if (r) return r
        continue
      }
      if (!st.isFile()) { rejectedFiles.push(rel(abs)); return { reason: '含非常规文件类型（设备/管道等）' } }
      fileCount += 1
      bytes += Number(st.size || 0)
      if (fileCount > limits.maxFiles) return { reason: '文件数超过上限 ' + limits.maxFiles }
      if (bytes > limits.maxBytes) return { reason: '总体积超过上限 ' + Math.round(limits.maxBytes / 1048576) + 'MB' }
      const relPath = rel(abs)
      const ext = extname(ent.name).toLowerCase()
      if (NATIVE_EXT.has(ext)) { nativeFiles.push(relPath); continue }
      if (!ALLOWED_EXT.has(ext)) { rejectedFiles.push(relPath); continue }
      if (ent.name === 'package.json' && current === dir && fileCount <= 2 || ent.name === 'package.json') {
        try {
          const pkg = JSON.parse(readFileSync(abs, 'utf8'))
          if (Array.isArray(pkg.os)) declaredOs = pkg.os.map(String)
          else if (typeof pkg.os === 'string') declaredOs = [pkg.os]
          if (Array.isArray(pkg.cpu)) declaredCpu = pkg.cpu.map(String)
          else if (typeof pkg.cpu === 'string') declaredCpu = [pkg.cpu]
          if (pkg.gypfile === true) gypfile = true
        } catch { return { reason: 'package.json 无法解析' } }
      }
    }
    return null
  }
  function rel(abs) { return abs.startsWith(dir + '/') || abs.startsWith(dir + '\\') ? abs.slice(dir.length + 1) : abs }

  const walkReject = walk(dir)
  if (walkReject) return reject(walkReject.reason)
  if (skipped > 0 && fileCount === 0) return reject('目录无法读取')
  if (nativeFiles.length) return reject('含原生二进制：' + nativeFiles.slice(0, 3).join(', '))
  if (rejectedFiles.length) return reject('含非纯文本/非 JS 文件：' + rejectedFiles.slice(0, 3).join(', '))
  if (gypfile) return reject('package.json 声明 gypfile（需要原生构建）')
  if (declaredOs && !declaredOs.includes(normalizeOs(osType))) return reject('package.json os 声明不含目标系统 ' + osType + '：' + declaredOs.join(','))
  if (declaredCpu && !declaredCpu.includes(normalizeArch(arch))) return reject('package.json cpu 声明不含目标架构 ' + arch + '：' + declaredCpu.join(','))
  if (fileCount === 0) return reject('目录为空')
  // 至少要有一个 JS 入口，避免空壳/资源目录被当成插件代码
  if (!hasJsEntry(dir)) return reject('未发现 .js/.mjs/.cjs 文件')
  return { pure: true, reason: '纯 JS 插件代码（' + fileCount + ' 文件 / ' + Math.round(bytes / 1024) + 'KB）', fileCount, bytes, nativeFiles, rejectedFiles, declaredOs: declaredOs || undefined, declaredCpu: declaredCpu || undefined }
}

function hasJsEntry(dir) {
  let found = false
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (ent.isDirectory()) { stack.push(join(cur, ent.name)); continue }
      const ext = extname(ent.name).toLowerCase()
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') { found = true; return true }
    }
  }
  return found
}
