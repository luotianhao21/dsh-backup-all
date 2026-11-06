// dsh-backup-all · 暂存区收集器
//
// 职责：把「要进快照的东西」落成一棵可打包的目录树 + 一份 manifest.json。
// 自动基线：DSH 配置文件 / 凭据 / Skill / 旧版 preset / plugin-guard；
// AI 追加：插件本体之外的外部文件（数据目录、自定义 skill 根、MCP 脚本等）。
//
// 明确不打包（用户选择「只打包配置与来源记录」）：
//   - profile/node_modules 里的插件代码本体（只在 manifest.plugins 里记元数据）
//   - $DSH_HOME/dshbox/dshbox-plugins 下的本地插件本体
//   - DSH 安装目录（/opt/dshapp/runtime）
//   - 插件自身目录、backup/data、会话、存储、缓存

import {
  existsSync, lstatSync, statSync, readdirSync, mkdirSync, copyFileSync, writeFileSync,
  readFileSync, rmSync, realpathSync, createReadStream,
} from 'node:fs'
import { basename, join, resolve, relative, sep, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { isInside, encodeTargetPath, decodeTargetPath, displayPath } from './paths.js'

const MAX_TOTAL_RAW_BYTES = 256 * 1024 * 1024 // 快照原始内容上限，防止误加巨型目录
const MAX_SINGLE_ENTRY_BYTES = 128 * 1024 * 1024
const MAX_FILES = 20000

/**
 * 恢复目标白名单校验（安全关键）：
 *  - 只接受 $DSH_HOME / $DSH_PROFILE_DIR / $WORKSPACE:<name> 编码串；
 *  - 或落在 dshHome / profileDir / 已知 workspace 内的绝对路径（会重新编码）；
 *  - 其它（例如 AI 注入的 /etc/cron.d/evil）一律退回到按 source 自动编码，
 *    绝不让 AI 直接决定恢复写入位置。
 */
export function sanitizeRestoreTarget(rawTarget, sourcePath, env, workspaces = []) {
  const fallback = encodeTargetPath(sourcePath, env, workspaces)
  const raw = String(rawTarget || '').trim()
  if (!raw) return fallback
  if (/^\$(DSH_HOME|DSH_PROFILE_DIR|WORKSPACE:)/.test(raw)) {
    // 编码串本身也要能解码回允许范围（防止 $WORKSPACE: 指向未知位置）
    const decoded = decodeTargetPath(raw, env, workspaces)
    if (!decoded) return fallback
    return raw
  }
  // Windows 绝对路径（C:\ / \\）与 POSIX（/）都要识别
  if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(raw)) {
    const abs = resolve(raw)
    const roots = [env.dshHome, env.profileDir]
    for (const ws of workspaces || []) if (ws && ws.path) roots.push(ws.path)
    for (const root of roots) {
      if (root && isInside(root, abs)) return encodeTargetPath(abs, env, workspaces)
    }
    return fallback
  }
  return fallback
}

// 与 archive.js 保持一致的自适应字节单位（避免循环依赖）
export function formatBytes(n) {
  const num = Number(n) || 0
  if (num < 1024) return Math.round(num) + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = num / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return (Math.round(v * 10) / 10).toString().replace(/\.0$/, '') + ' ' + units[i]
}

function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    try {
      const hash = createHash('sha256')
      const st = statSync(file)
      if (st.size <= 4 * 1024 * 1024) {
        hash.update(readFileSync(file))
        resolvePromise(hash.digest('hex'))
        return
      }
      const stream = createReadStream(file)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolvePromise(hash.digest('hex')))
    } catch (error) {
      reject(error)
    }
  })
}

/** 递归统计一个路径（不跟随符号链接；符号链接按 target 字符串长度算 0） */
export function measurePath(target) {
  const result = { bytes: 0, files: 0, dirs: 0, symlinks: 0, truncated: false }
  const walk = (p, depth) => {
    if (result.truncated || depth > 40) return
    let st
    try {
      st = lstatSync(p)
    } catch {
      return
    }
    if (st.isSymbolicLink()) {
      result.symlinks++
      return
    }
    if (st.isDirectory()) {
      result.dirs++
      let names = []
      try {
        names = readdirSync(p)
      } catch {
        return
      }
      for (const name of names) {
        walk(join(p, name), depth + 1)
        if (result.truncated) return
      }
      return
    }
    if (st.isFile()) {
      result.files++
      result.bytes += st.size
      if (result.files > MAX_FILES || result.bytes > MAX_SINGLE_ENTRY_BYTES) result.truncated = true
    }
  }
  walk(target, 0)
  return result
}

async function getDocRenderers() {
  try {
    const mod = await import('./restore-doc.js')
    if (mod && typeof mod.renderRestoreDoc === 'function') return mod
  } catch {}
  // 兜底渲染器：prompt 模块缺失时也必须能出包（宁可朴素，不可失败）
  return {
    renderRestoreDoc: (input) => {
      const m = (input && input.manifest) || {}
      const lines = []
      lines.push('# 快照恢复说明（' + ((input.record && input.record.name) || '') + '）')
      lines.push('')
      lines.push('> 由 dsh-backup-all 自动生成。快照时间：' + ((input.record && input.record.createdAt) || ''))
      lines.push('')
      if (input.aiDoc) {
        lines.push(String(input.aiDoc))
        lines.push('')
      }
      lines.push('## 1. 快照内容')
      const entries = m.entries || []
      lines.push('共 ' + entries.length + ' 个条目：')
      for (const e of entries) lines.push('- `' + e.target + '` ← `' + e.source + '`（' + (e.kind || 'file') + '）')
      lines.push('')
      lines.push('## 2. 环境要求')
      lines.push('- DSH 版本：`' + ((m.environment && m.environment.dshVersion) || '未知') + '`')
      lines.push('- profile：`' + ((m.environment && m.environment.profileName) || '') + '`')
      lines.push('- DSH_HOME：`' + ((m.environment && m.environment.dshHome) || '') + '`')
      lines.push('')
      lines.push('## 3. 恢复步骤')
      lines.push('1. 先做一次当前环境的快照（恢复窗口会自动创建「恢复前快照」）。')
      lines.push('2. 把 `files/` 下各条目按 manifest 的目标路径放回（`$DSH_HOME` = DSH 家目录，`$DSH_PROFILE_DIR` = profile 目录）。')
      lines.push('3. 插件代码本体不在包内，按 manifest.plugins 重新安装：`dsh plugin --profile <name> add <source>`，再 `pnpm install`。')
      lines.push('4. 重启 DSH。')
      lines.push('')
      lines.push('## 4. 插件清单（本体未打包）')
      for (const p of m.plugins || []) lines.push('- `' + p.name + '` ' + (p.version || '') + ' ← ' + (p.source || p.availability || ''))
      lines.push('')
      if (Array.isArray(m.excluded) && m.excluded.length) {
        lines.push('## 5. 未打包内容')
        for (const x of m.excluded) lines.push('- `' + x.path + '`：' + x.why)
      }
      return lines.join('\n') + '\n'
    },
    renderInventoryDoc: (manifest) => {
      const lines = ['# 快照清单', '']
      lines.push('| 类型 | 源路径 | 恢复目标 | 大小 |')
      lines.push('| --- | --- | --- | --- |')
      for (const e of (manifest && manifest.entries) || []) {
        lines.push('| ' + (e.kind || '') + ' | `' + e.source + '` | `' + e.target + '` | ' + (e.bytes || 0) + ' B |')
      }
      return lines.join('\n') + '\n'
    },
  }
}

/**
 * @param {object} opts
 * @param {object} opts.env             resolveEnv() 结果
 * @param {object} opts.inventory       scanInventory() 结果
 * @param {Array}  opts.workspaces      [{id,path,name,title}]
 * @param {string} opts.stagingDir      本次运行的暂存目录（已创建）
 * @param {(text:string)=>void} [opts.log]
 * @param {object} [opts.context]       额外上下文（如 pluginPackageName）
 */
export function createCollector({ env, inventory, workspaces = [], stagingDir, log, options = {} }) {
  // 快照策略（用户可在高级设置里改）：
  //   packPluginCode: 'local-only'(默认，不可再下载的本地插件代码必须入包) | 'all' | 'none'
  //   excludeCredentials: true 时不打包 .credentials.yaml
  const packPluginCode = ['all', 'none'].includes(options.packPluginCode) ? options.packPluginCode : 'local-only'
  const excludeCredentials = options.excludeCredentials === true
  const out = (text) => {
    try {
      log && log(text)
    } catch {}
  }
  const entries = [] // {kind, source, why, target, note, isDirectory, bytes, files, notPackedReason}
  const sourceSet = new Set()
  const excluded = []
  const warnings = []

  const allowedExternalRoots = () => {
    const roots = [env.dshHome, env.profileDir, env.homeDir]
    for (const w of workspaces || []) if (w && w.path) roots.push(w.path)
    return roots
  }

  /** 判断一个绝对路径是否属于“插件代码本体/系统内部”，属于则拒绝打包 */
  function rejectReason(absPath) {
    const p = resolve(absPath)
    const denied = []
    if (isInside(env.pluginRoot, p)) denied.push('这是快照插件自身目录')
    if (isInside(env.backupDir, p)) denied.push('这是快照输出目录')
    if (isInside(env.dataDir, p)) denied.push('这是快照插件数据目录')
    if (isInside(join(env.dshHome, 'sessions'), p)) denied.push('这是 DSH 会话数据')
    if (isInside(join(env.dshHome, 'storages'), p)) denied.push('这是 DSH 内部存储')
    if (isInside(join(env.profileDir, 'node_modules'), p)) denied.push('插件代码本体不打包（只在 manifest.plugins 记录来源）')
    if (isInside(join(env.dshHome, 'dshbox', 'dshbox-plugins'), p)) denied.push('本地插件代码本体不打包（只在 manifest.plugins 记录来源）')
    return denied.length ? denied.join('；') : ''
  }

  /** 自动基线：DSH 配置 / 凭据 / Skill / 旧版 preset / plugin-guard */
  function seedBaseline() {
    const seen = new Set()
    const pushEntry = (entry) => {
      if (!entry || !entry.source || seen.has(entry.source)) return
      seen.add(entry.source)
      if (!existsSync(entry.source)) {
        excluded.push({ path: entry.source, why: '不存在，已跳过' })
        return
      }
      const measured = measurePath(entry.source)
      const isDir = (() => {
        try {
          return statSync(entry.source).isDirectory()
        } catch {
          return false
        }
      })()
      entries.push({
        kind: entry.kind || 'file',
        source: entry.source,
        why: entry.why || '',
        target: entry.target || encodeTargetPath(entry.source, env, workspaces),
        note: entry.note || '',
        pluginPackageName: entry.pluginPackageName || '',
        isDirectory: isDir,
        bytes: measured.bytes,
        files: measured.files,
        symlinks: measured.symlinks,
      })
      sourceSet.add(entry.source)
    }

    for (const cf of inventory?.configFiles || []) {
      if (!cf || !cf.exists) continue
      let kind = 'config'
      let why = 'DSH 配置文件（' + (cf.role || '') + '）'
      if (cf.role === 'credentials') {
        kind = 'credentials'
        why = 'DSH 凭据文件（含 API Key/token，用户选择打包）'
      }
      pushEntry({ kind, source: cf.path, why })
    }

    // 凭据文件：可在高级设置里选择「不打包凭据」（excludeCredentials）；默认打包。
    // 注意：内容绝不喂给模型（read 工具另行拒绝），只作为文件原样进包。
    try {
      if (excludeCredentials) {
        if (existsSync(env.credentialsFile)) {
          excluded.push({ path: env.credentialsFile, why: '按设置「不打包凭据」跳过；恢复后需要重新填写密钥' })
        }
      } else if (existsSync(env.credentialsFile)) {
        pushEntry({ kind: 'credentials', source: env.credentialsFile, why: 'DSH 凭据文件（含 API Key/token；压缩包含明文，请妥善保管）' })
      }
    } catch {}

    // 插件代码本体：默认把「不可再下载」的本地插件代码一并打包（换机器也丢不了）；
    // 可再下载的 registry/安装包默认只记元数据，用户可选 all 全部打包。
    if (packPluginCode !== 'none') {
      for (const plugin of inventory?.plugins || []) {
        if (!plugin || !plugin.packageName || !plugin.codeDir) continue
        if (plugin.kind === 'installation') continue
        const shouldPack = packPluginCode === 'all' || plugin.redownloadable === false || plugin.packedByDefault === true
        if (!shouldPack) continue
        try {
          if (!existsSync(plugin.codeDir)) continue
        } catch {
          continue
        }
        pushEntry({
          kind: 'plugin-code',
          source: plugin.codeDir,
          why:
            plugin.redownloadable === false
              ? '本地插件（不可再下载）代码本体：恢复时先放回代码目录再重新链接'
              : '按设置「打包全部插件代码」打包的插件代码本体',
          note: plugin.packageName,
          pluginPackageName: plugin.packageName,
        })
      }
    }

    for (const skill of inventory?.skills || []) {
      if (!skill || !skill.path) continue
      pushEntry({ kind: 'skill', source: skill.path, why: 'Skill（' + (skill.source || '') + '）' })
    }

    // 旧版 agent preset 目录：整个目录作为一个条目
    try {
      if (existsSync(env.legacyPresetDir) && statSync(env.legacyPresetDir).isDirectory()) {
        pushEntry({ kind: 'preset', source: env.legacyPresetDir, why: '旧版 Agent Preset 目录' })
      }
    } catch {}

    // plugin-guard 属于 dshbox 的插件安全状态，恢复时用得上
    try {
      if (existsSync(env.pluginGuardFile)) pushEntry({ kind: 'config', source: env.pluginGuardFile, why: 'dshbox 插件安全状态' })
    } catch {}
  }

  /** AI 追加外部路径 */
  function addPath(absPath, meta = {}) {
    const raw = String(absPath || '').trim()
    if (!raw) return { ok: false, error: '路径为空' }
    const p = resolve(raw)
    const kind = String(meta.kind || 'external')
    if (kind === 'plugin-code') {
      const known = (inventory?.plugins || []).find((plugin) => {
        if (!plugin || !plugin.codeDir) return false
        try {
          const codeDir = resolve(plugin.codeDir)
          return p === codeDir || isInside(codeDir, p) || isInside(p, codeDir)
        } catch {
          return false
        }
      })
      if (!known) {
        return { ok: false, error: 'plugin-code 只能添加已安装插件的代码目录（或其中的文件），请先从清单确认该插件的 codeDir', path: p }
      }
      if (packPluginCode === 'none') {
        return { ok: false, error: '当前设置是「不打包插件代码本体」，无法添加 plugin-code 条目', path: p }
      }
      if (packPluginCode !== 'all' && known.redownloadable !== false) {
        return {
          ok: false,
          error: '该插件可再下载（sourceKind=' + (known.sourceKind || 'unknown') + '），按当前设置只记元数据；如需打包全部插件代码，请在高级设置切换「打包插件代码本体」',
          path: p,
        }
      }
      meta = { ...meta, kind: 'plugin-code', note: meta.note || known.packageName }
    } else {
      const denied = rejectReason(p)
      if (denied) return { ok: false, error: denied, path: p }
    }
    let st
    try {
      st = lstatSync(p)
    } catch {
      return { ok: false, error: '路径不存在或不可访问：' + p, path: p }
    }
    if (st.isSymbolicLink()) {
      let real = p
      try {
        real = realpathSync(p)
      } catch {}
      if (kind !== 'plugin-code') {
        const deniedReal = rejectReason(real)
        if (deniedReal) return { ok: false, error: '符号链接指向不允许打包的位置：' + deniedReal, path: p }
      }
      return addPath(real, meta)
    }
    // 已被更上层的条目覆盖？
    for (const e of entries) {
      if (p === e.source) return { ok: true, already: true, path: p, message: '已包含' }
      if (isInside(e.source, p)) return { ok: true, already: true, path: p, message: '已被条目 ' + e.source + ' 包含' }
    }
    const measured = measurePath(p)
    if (measured.truncated) return { ok: false, error: '路径过大（超过单条目上限 ' + formatBytes(MAX_SINGLE_ENTRY_BYTES) + '）', path: p }
    const currentTotal = entries.reduce((sum, e) => sum + (e.bytes || 0), 0)
    if (currentTotal + measured.bytes > MAX_TOTAL_RAW_BYTES) {
      return { ok: false, error: '快照原始内容将超过上限 ' + formatBytes(MAX_TOTAL_RAW_BYTES) + '，请移除一些大文件', path: p }
    }
    entries.push({
      kind: ['plugin-data', 'skill', 'mcp', 'preset', 'config', 'external', 'credentials', 'plugin-code'].includes(kind) ? kind : 'external',
      source: p,
      why: String(meta.why || 'AI 判断为插件本体之外的外部文件'),
      target: sanitizeRestoreTarget(meta.target, p, env, workspaces),
      note: String(meta.note || ''),
      isDirectory: measured.dirs > 0 || st.isDirectory(),
      bytes: measured.bytes,
      files: measured.files,
      symlinks: measured.symlinks,
    })
    sourceSet.add(p)
    out('追加外部文件：' + displayPath(p, env) + '（' + formatBytes(measured.bytes) + '）')
    return { ok: true, path: p, bytes: measured.bytes, files: measured.files, target: entries[entries.length - 1].target }
  }

  function removePath(absPath) {
    const p = resolve(String(absPath || ''))
    const idx = entries.findIndex((e) => e.source === p)
    if (idx === -1) {
      // 允许删已经被上层目录包含的？只按精确匹配删
      return { ok: false, error: '没有这个条目：' + p }
    }
    const [removed] = entries.splice(idx, 1)
    sourceSet.delete(p)
    out('移除条目：' + displayPath(p, env))
    return { ok: true, removed: { source: removed.source, kind: removed.kind } }
  }

  function list() {
    return entries.map((e) => ({
      kind: e.kind,
      source: e.source,
      target: e.target,
      why: e.why,
      bytes: e.bytes,
      files: e.files,
      isDirectory: e.isDirectory,
    }))
  }

  /** 复制一个条目到暂存区（保持相对结构），返回归档内相对路径 */
  async function copyEntry(entry, index) {
    const safeName = basename(entry.source).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_') || 'item'
    const relDir = 'files/' + String(index).padStart(4, '0') + '_' + safeName
    const destAbs = join(stagingDir, relDir)
    const written = []
    const walk = (src, dest) => {
      let st
      try {
        st = lstatSync(src)
      } catch {
        return
      }
      if (st.isSymbolicLink()) {
        // 外部条目里的符号链接：解引用复制（跨机器恢复更稳），指向不允许位置则跳过
        let real = src
        try {
          real = realpathSync(src)
        } catch {
          warnings.push('符号链接无法解析，已跳过：' + src)
          return
        }
        const denied = rejectReason(real)
        if (denied) {
          warnings.push('符号链接指向不允许位置，已跳过：' + src)
          return
        }
        walk(real, dest)
        return
      }
      if (st.isDirectory()) {
        mkdirSync(dest, { recursive: true })
        for (const name of readdirSync(src)) walk(join(src, name), join(dest, name))
        return
      }
      if (st.isFile()) {
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(src, dest)
        written.push(relative(stagingDir, dest).split(sep).join('/'))
      }
    }
    walk(entry.source, destAbs)
    return { relDir, written }
  }

  /**
   * 生成暂存区：files/ + manifest.json + RESTORE.md + INVENTORY.md + restore-plan.json
   * @returns {Promise<{manifest, rawBytes, fileCount, entries:number}>}
   */
  async function build({ snapshot = {}, restorePlan = null, aiDoc = '' } = {}) {
    rmSync(join(stagingDir, 'files'), { recursive: true, force: true })
    mkdirSync(join(stagingDir, 'files'), { recursive: true })
    const manifestEntries = []
    let rawBytes = 0
    let fileCount = 0
    let index = 0
    for (const entry of entries) {
      index++
      try {
        const copy = await copyEntry(entry, index)
        rawBytes += entry.bytes || 0
        fileCount += copy.written.length
        manifestEntries.push({
          kind: entry.kind,
          pluginPackageName: entry.pluginPackageName || '',
          source: entry.source,
          sourceDisplay: displayPath(entry.source, env),
          target: entry.target,
          why: entry.why,
          note: entry.note,
          archivePath: copy.relDir,
          isDirectory: Boolean(entry.isDirectory),
          bytes: entry.bytes || 0,
          files: copy.written.length,
          sha256: !entry.isDirectory && copy.written.length === 1 ? await sha256File(entry.source).catch(() => '') : '',
        })
      } catch (error) {
        warnings.push('条目复制失败：' + entry.source + '（' + String((error && error.message) || error) + '）')
      }
    }

    // 插件元数据完整记进 manifest；代码是否入包取决于「可再下载性 + 用户设置」
    const codeEntryByPlugin = new Map()
    for (const item of manifestEntries) {
      if (item.kind !== 'plugin-code') continue
      const name = item.pluginPackageName || item.note || ''
      if (name && !codeEntryByPlugin.has(name)) codeEntryByPlugin.set(name, item)
    }
    const plugins = (inventory?.plugins || []).map((p) => {
      const codeEntry = codeEntryByPlugin.get(p.packageName) || null
      const packed = Boolean(codeEntry)
      let hint
      if (packed) {
        hint = '代码本体已入包：恢复时先解出到 codeTarget（或重映射后的目录），再执行 dsh plugin --profile <name> add file:<目录> 重新链接/安装'
      } else if (p.redownloadable === false) {
        hint = '不可再下载的本地插件但代码未入包（当前设置 packPluginCode=none）：恢复时原始源码目录必须存在，否则需手工找回代码'
      } else {
        hint = '可再下载（' + (p.sourceKind || 'registry') + '）：用 dsh plugin --profile <name> add ' +
          (p.spec || (p.packageName + (p.version ? '@' + p.version : ''))) + ' 重装'
      }
      return {
        name: p.packageName,
        version: p.version || '',
        packageDir: p.packageDir || '',
        external: Boolean(p.externalToProfile),
        linkTarget: p.linkTarget || '',
        bundled: Boolean(p.bundled),
        source: p.source || p.spec || '',
        spec: p.spec || '',
        sourceKind: p.sourceKind || 'unknown',
        redownloadable: p.redownloadable === true ? true : p.redownloadable === false ? false : 'unknown',
        bundle: Boolean(p.bundle),
        rows: p.rows || [],
        codeDir: p.codeDir || '',
        codeTarget: packed ? encodeTargetPath(p.codeDir, env, workspaces) : '',
        codeArchivePath: codeEntry ? codeEntry.archivePath : '',
        packed,
        restoreHint: hint,
      }
    })

    const manifest = {
      formatVersion: 1,
      generator: 'dsh-backup-all',
      createdAt: new Date().toISOString(),
      snapshot: {
        name: String(snapshot.name || ''),
        description: String(snapshot.description || ''),
        kind: snapshot.kind || 'snapshot',
      },
      environment: {
        dshHome: env.dshHome,
        profileName: env.profileName,
        profileDir: env.profileDir,
        homeDir: env.homeDir,
        osType: env.osType,
        platform: env.platform,
        arch: env.arch,
        osRelease: env.osRelease,
        nodeVersion: env.nodeVersion,
        dshVersion: inventory?.dshVersion || null,
      },
      workspaces: (workspaces || []).map((w) => ({ id: w.id || '', name: w.name || w.title || '', path: w.path || '' })),
      configFiles: inventory?.configFiles || [],
      plugins,
      bundles: inventory?.bundles || [],
      skills: inventory?.skills || [],
      patchRows: (inventory?.mcpRows || []).concat(inventory?.presetRows || []),
      mcpRows: inventory?.mcpRows || [],
      presetRows: inventory?.presetRows || [],
      presetRegistryRows: inventory?.presetRegistryRows || [],
      entries: manifestEntries,
      excluded: (inventory?.excluded || [])
        .filter((x) => !(x && x.path === env.credentialsFile))
        .concat(excluded),
      warnings: (inventory?.warnings || []).concat(warnings),
      credentialsIncluded: entries.some((entry) => entry.kind === 'credentials'),
      notPacked: (inventory?.plugins || [])
        .filter((p) => !codeEntryByPlugin.has(p.packageName))
        .map((p) => ({
          kind: 'plugin-code',
          path: p.codeDir || p.packageDir || p.packageName,
          why:
            p.redownloadable === false
              ? '本地插件代码未入包（设置 packPluginCode=none）：恢复时原始目录必须存在'
              : '可再下载，代码本体不打包，只记元数据（用 dsh plugin add 重装）',
        })),
      snapshotPolicy: {
        packPluginCode,
        excludeCredentials,
        credentialsIncluded: entries.some((entry) => entry.kind === 'credentials'),
        // 区分「按策略排除」与「快照时本来就没有凭据文件」，恢复侧据此写不同提示
        credentialsFilePresent: (() => {
          try {
            return existsSync(env.credentialsFile)
          } catch {
            return false
          }
        })(),
        pluginCodePacked: [...codeEntryByPlugin.keys()],
      },
    }

    const restorePlanFinal = restorePlan || {
      steps: [
        { id: 'restore-files', title: '放回配置文件与外部文件', description: '按 manifest.entries 的 target 恢复 files/ 下的条目' },
        { id: 'reinstall-plugins', title: '重新安装插件', description: '按 manifest.plugins 执行 dsh plugin --profile <name> add <source>' },
        { id: 'restart', title: '重启 DSH', description: '插件与配置变更需要重启后生效' },
      ],
    }

    const renderers = await getDocRenderers()
    const restoreDoc = renderers.renderRestoreDoc({
      record: {
        name: snapshot.name || '',
        description: snapshot.description || '',
        createdAt: manifest.createdAt,
        file: snapshot.file || '',
        kind: snapshot.kind || 'snapshot',
      },
      manifest,
      plan: restorePlanFinal,
      aiDoc: String(aiDoc || ''),
      environment: manifest.environment,
    })
    let inventoryDoc = ''
    try {
      inventoryDoc = renderers.renderInventoryDoc(manifest)
    } catch {}

    writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    writeFileSync(join(stagingDir, 'restore-plan.json'), JSON.stringify(restorePlanFinal, null, 2) + '\n', 'utf8')
    writeFileSync(join(stagingDir, 'RESTORE.md'), String(restoreDoc || '') + '\n', 'utf8')
    writeFileSync(join(stagingDir, 'INVENTORY.md'), String(inventoryDoc || '') + '\n', 'utf8')

    return {
      manifest,
      rawBytes,
      fileCount,
      entries: manifestEntries.length,
      warnings,
    }
  }

  seedBaseline()

  return {
    env,
    entries,
    addPath,
    removePath,
    list,
    build,
    get sizeSummary() {
      return {
        entries: entries.length,
        bytes: entries.reduce((sum, e) => sum + (e.bytes || 0), 0),
      }
    },
    info: () => ({
      entryCount: entries.length,
      bytes: entries.reduce((sum, e) => sum + (e.bytes || 0), 0),
      entries: list(),
    }),
  }
}
