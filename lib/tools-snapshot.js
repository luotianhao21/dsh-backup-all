// dsh-backup-all · 快照 AI 可调用的工具
//
// 这些工具只暴露给“快照 AI”（插件里自己配的那个模型），不注册进 DSH 主 Agent 的工具表。
// 设计原则：
//  - Host 已经做了确定性扫描，AI 的职责是「理解 + 找漏掉的外部文件 + 写恢复说明 + 控制进度」。
//  - 工具结果有长度上限，避免把上下文撑爆；需要细看时用 offset/limit 再来一次。
//  - 所有读取都限制在 DSH 相关路径内，且会话/存储/密钥内容不喂给模型。

import { existsSync, readdirSync, lstatSync, statSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { isInside, displayPath } from './paths.js'

const MAX_TEXT_CHARS = 20000
const MAX_JSON_CHARS = 18000

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function jsonOut(value) {
  let text = JSON.stringify(value)
  if (text.length > MAX_JSON_CHARS) {
    text = JSON.stringify(value, null, 0)
    text = text.slice(0, MAX_JSON_CHARS) + '…[结果过长已截断，请用 section/offset/limit 分段读取]'
  }
  return text
}

function summarizeInventory(inventory, policy) {
  const bundles = inventory?.bundles || []
  const plugins = inventory?.plugins || []
  const skills = inventory?.skills || []
  return {
    profileName: inventory?.profileName,
    dshHome: inventory?.dshHome,
    profileDir: inventory?.profileDir,
    configFiles: (inventory?.configFiles || []).map((c) => ({ path: c.path, role: c.role, exists: c.exists, bytes: c.bytes })),
    counts: {
      bundles: bundles.length,
      enabledBundles: bundles.filter((b) => b.enabled !== false).length,
      plugins: plugins.length,
      skills: skills.length,
      patchRows: (inventory?.patchRows || []).length,
      mcpRows: (inventory?.mcpRows || []).length,
      presetRows: (inventory?.presetRows || []).length,
      externalCandidates: (inventory?.externalCandidates || []).length,
    },
    plugins: (inventory?.plugins || []).map((p) => ({
      packageName: p.packageName,
      version: p.version,
      kind: p.kind,
      spec: p.spec || null,
      sourceKind: p.sourceKind || 'unknown',
      redownloadable: p.redownloadable === true ? true : p.redownloadable === false ? false : 'unknown',
      codeDir: p.codeDir || null,
      packedByDefault: p.packedByDefault === true,
      externalToProfile: Boolean(p.externalToProfile),
    })),
    skills: skills.map((s) => ({ name: s.name, path: s.path, root: s.root, source: s.source })),
    mcpRows: (inventory?.mcpRows || []).map((r) => ({ file: r.file, rowId: r.rowId, configText: String(r.configText || '').slice(0, 2000) })),
    presetRows: (inventory?.presetRows || []).map((r) => ({ file: r.file, rowId: r.rowId, configText: String(r.configText || '').slice(0, 2000) })),
    presetRegistryRows: (inventory?.presetRegistryRows || []).map((r) => ({ file: r.file, rowId: r.rowId })),
    externalCandidates: (inventory?.externalCandidates || []).map((c) => ({ path: c.path, why: c.why, kind: c.kind })),
    warnings: (inventory?.warnings || []).slice(0, 40),
    excluded: (inventory?.excluded || []).slice(0, 40),
    snapshotPolicy: {
      packPluginCode: (policy || {}).packPluginCode || 'local-only',
      excludeCredentials: (policy || {}).excludeCredentials === true,
      rule:
        (policy || {}).packPluginCode === 'none'
          ? '不打包任何插件代码本体（不可再下载的本地插件会在恢复时缺失，需谨慎）'
          : (policy || {}).packPluginCode === 'all'
            ? '打包全部插件代码本体'
            : '不可再下载的本地插件代码本体必须入包；可再下载的插件只记元数据',
    },
  }
}

/** 读权限：DSH 家目录 / profile / 用户目录 / 各 workspace / DSH 安装目录（只读了解） */
export function makeReadGuard(env, workspaces) {
  const readRoots = [env.dshHome, env.profileDir, env.homeDir]
  for (const ws of workspaces || []) if (ws && ws.path) readRoots.push(ws.path)
  readRoots.push('/opt/dshapp/runtime')
  // 明确禁止读进模型的内容：密钥、会话、内部存储、快照自身
  const denyRoots = [
    join(env.dshHome, 'sessions'),
    join(env.dshHome, 'storages'),
    env.backupDir,
    env.dataDir,
    env.pluginRoot,
  ]
  const denyFiles = ['/proc', '/sys', '/dev']
  const credentialReal = (() => {
    try {
      return realpathSync(env.credentialsFile)
    } catch {
      return resolve(env.credentialsFile)
    }
  })()

  function checkTarget(abs, real) {
    for (const d of denyFiles) if (abs === d || abs.startsWith(d + '/')) return '不允许访问该路径'
    for (const d of denyRoots) if (isInside(d, abs)) return '不允许读取快照/会话/内部存储/插件自身目录'
    if (abs === resolve(env.credentialsFile) || abs === credentialReal) return '凭据文件内容不应提供给模型（它会被原样打包，但内容保持不读）'
    let allowed = false
    for (const root of readRoots) if (isInside(root, abs)) { allowed = true; break }
    if (!allowed) return '路径不在允许读取的范围内（DSH_HOME、profile、用户目录、workspace、DSH 安装目录）'
    if (real && real !== abs) {
      // 符号链接必须解析后再次过一遍全部规则，否则可借 file: 链接的 node_modules 符号链接读任意文件
      return checkTarget(real, null)
    }
    return ''
  }

  return function guard(p) {
    const abs = resolve(p)
    let real = null
    try {
      real = realpathSync(abs)
    } catch {
      real = null // 路径不存在/不可解析：按字面路径检查即可
    }
    return checkTarget(abs, real)
  }
}

function listDir(path, depth, limit) {
  const items = []
  const walk = (dir, currentDepth) => {
    if (items.length >= limit) return
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (items.length >= limit) return
      const abs = join(dir, name)
      let st
      try {
        st = lstatSync(abs)
      } catch {
        continue
      }
      const item = {
        name,
        path: abs,
        type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
        size: st.isFile() ? st.size : 0,
      }
      items.push(item)
      if (st.isDirectory() && currentDepth < depth) walk(abs, currentDepth + 1)
    }
  }
  walk(path, 1)
  return items
}

/**
 * @param {object} deps
 * @param {object} deps.env
 * @param {object} deps.inventory
 * @param {object} deps.collector
 * @param {Array}  deps.workspaces
 * @param {object} deps.run           当前 run（用于 setProgress / log）
 * @param {(patch:{progress?,phase?,message?})=>void} deps.setProgress
 * @param {(kind:string,text:string)=>void} deps.log
 * @param {(plan:object)=>void} deps.setRestorePlan
 * @param {(doc:string)=>void} deps.setRestoreDoc
 * @param {(opts:object)=>Promise<object>} deps.buildArchive
 */
export function createSnapshotTools(deps) {
  const { env, inventory, collector, workspaces = [], setProgress, log, setRestorePlan, setRestoreDoc, buildArchive, policy } = deps
  const snapshotPolicy = policy || { packPluginCode: 'local-only', excludeCredentials: false }
  const guard = makeReadGuard(env, workspaces)
  const inventorySummary = summarizeInventory(inventory, snapshotPolicy)
  let inventoryCallCount = 0

  const tools = [
    {
      name: 'backup_get_inventory',
      description:
        '获取 Host 已经扫描好的 DSH 安装项清单（插件 bundle / skill / MCP 行 / Agent Preset 行 / 配置文件 / 外部候选）。这是第一步，先看它再决定读哪些文件。结果可能较长，用 section 分段取。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section: {
            type: 'string',
            enum: ['summary', 'configFiles', 'plugins', 'skills', 'patchRows', 'mcpRows', 'presetRows', 'externalCandidates', 'collected', 'all'],
            description: '要看的片段；默认 summary',
          },
          offset: { type: 'number', description: '分页偏移（条），默认 0' },
          limit: { type: 'number', description: '每页条数，默认 60，最大 200' },
        },
      },
      async execute(args = {}) {
        inventoryCallCount++
        if (inventoryCallCount > 3) {
          return jsonOut({
            ok: false,
            error: 'backup_get_inventory 已调用 ' + (inventoryCallCount - 1) + ' 次。请不要再重复拉取，使用已有信息推进；缺少细节时用 backup_read_text 读具体文件。',
          })
        }
        const section = String(args.section || 'summary')
        const offset = clampInt(args.offset, 0, 100000, 0)
        const limit = clampInt(args.limit, 1, 200, 60)
        if (section === 'summary' || section === 'all') {
          return jsonOut({ ok: true, inventory: inventorySummary })
        }
        if (section === 'collected') {
          const items = collector.list()
          return jsonOut({ ok: true, section, total: items.length, items, policy: snapshotPolicy })
        }
        const datasets = {
          configFiles: inventory?.configFiles || [],
          plugins: (inventory?.plugins || []).map((p) => ({
            packageName: p.packageName,
            version: p.version,
            packageDir: p.packageDir,
            externalToProfile: p.externalToProfile,
            linkTarget: p.linkTarget,
            kind: p.kind,
            sizeBytes: p.sizeBytes,
            bundled: p.bundled,
            spec: p.spec || null,
            sourceKind: p.sourceKind || 'unknown',
            redownloadable: p.redownloadable === true ? true : p.redownloadable === false ? false : 'unknown',
            codeDir: p.codeDir || null,
            packedByDefault: p.packedByDefault === true,
          })),
          skills: inventory?.skills || [],
          patchRows: (inventory?.patchRows || []).map((r) => ({
            file: r.file,
            id: r.id,
            name: r.name,
            disabled: r.disabled,
            selected: (inventory?.mcpRows || []).some((m) => m.file === r.file && m.rowId === r.id)
              ? 'mcp'
              : (inventory?.presetRows || []).some((m) => m.file === r.file && m.rowId === r.id)
                ? 'preset'
                : undefined,
          })),
          mcpRows: inventory?.mcpRows || [],
          presetRows: inventory?.presetRows || [],
          externalCandidates: inventory?.externalCandidates || [],
        }
        const data = datasets[section] || []
        const page = data.slice(offset, offset + limit)
        return jsonOut({ ok: true, section, total: data.length, offset, limit, items: page, hasMore: offset + limit < data.length })
      },
      summarize: () => '已读取安装项清单',
    },
    {
      name: 'backup_set_progress',
      description:
        '刷新界面进度条。必须周期性调用：开始、每进入一个新阶段、以及至少每 30~60 秒一次。progress 是 0-100 的总进度，phase 是简短阶段名（10 字内），message 是可选的当前动作说明。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          progress: { type: 'number', description: '0-100 的总进度' },
          phase: { type: 'string', description: '阶段名，如「分析插件」「查找外部文件」「写恢复说明」' },
          message: { type: 'string', description: '当前动作细节（可选，给用户看）' },
        },
        required: ['progress', 'phase'],
      },
      async execute(args = {}) {
        const progress = clampInt(args.progress, 0, 100, 0)
        setProgress({ progress, phase: String(args.phase || '').slice(0, 40), message: String(args.message || '').slice(0, 200) })
        return '进度已更新为 ' + progress + '%'
      },
      summarize: (v) => String(v),
    },
    {
      name: 'backup_list_dir',
      description: '列出一个目录的内容（用于确认某个插件/数据目录里有什么）。最多两层、默认 120 条。不能读会话、存储、密钥、快照自身目录。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: '绝对路径' },
          depth: { type: 'number', description: '递归层数 1-2，默认 1' },
          limit: { type: 'number', description: '最多返回条数，默认 120，最大 300' },
        },
        required: ['path'],
      },
      async execute(args = {}) {
        const p = String(args.path || '')
        const denied = guard(p)
        if (denied) return jsonOut({ ok: false, error: denied })
        try {
          const st = statSync(p)
          if (!st.isDirectory()) return jsonOut({ ok: false, error: '不是目录：' + p })
        } catch {
          return jsonOut({ ok: false, error: '目录不存在：' + p })
        }
        const items = listDir(p, clampInt(args.depth, 1, 2, 1), clampInt(args.limit, 1, 300, 120))
        return jsonOut({
          ok: true,
          path: p,
          count: items.length,
          items: items.map((i) => ({ name: i.name, type: i.type, size: i.size, path: i.path })),
        })
      },
      summarize: (v) => {
        try {
          return '列目录：' + (JSON.parse(v).count ?? '?') + ' 项'
        } catch {
          return '列目录完成'
        }
      },
    },
    {
      name: 'backup_read_text',
      description: '读取一个文本文件（配置 YAML/JSON/Markdown 等），最多 20000 字符，可用 offset 续读。用于读懂 package.json、cordis.patch.yml、MCP/Preset 行、插件说明等。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: '绝对路径' },
          offset: { type: 'number', description: '起始字符偏移，默认 0' },
          limit: { type: 'number', description: '最多字符数，默认 20000，最大 20000' },
        },
        required: ['path'],
      },
      async execute(args = {}) {
        const p = String(args.path || '')
        const denied = guard(p)
        if (denied) return jsonOut({ ok: false, error: denied })
        let st
        try {
          st = statSync(p)
        } catch {
          return jsonOut({ ok: false, error: '文件不存在：' + p })
        }
        if (!st.isFile()) return jsonOut({ ok: false, error: '不是普通文件：' + p })
        if (st.size > 4 * 1024 * 1024) return jsonOut({ ok: false, error: '文件过大（>4MB），不适合直接读取' })
        let text = ''
        try {
          text = readFileSync(p, 'utf8')
        } catch (error) {
          return jsonOut({ ok: false, error: '读取失败：' + String((error && error.message) || error) })
        }
        const offset = clampInt(args.offset, 0, text.length, 0)
        const limit = clampInt(args.limit, 1, MAX_TEXT_CHARS, MAX_TEXT_CHARS)
        const slice = text.slice(offset, offset + limit)
        return jsonOut({
          ok: true,
          path: p,
          totalChars: text.length,
          offset,
          returned: slice.length,
          truncated: offset + slice.length < text.length,
          text: slice,
        })
      },
      summarize: () => '读取文件',
    },
    {
      name: 'backup_stat',
      description: '查看一个路径的类型/大小/修改时间（判断是文件还是目录、是否值得打包）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', description: '绝对路径' } },
        required: ['path'],
      },
      async execute(args = {}) {
        const p = String(args.path || '')
        const denied = guard(p)
        if (denied) return jsonOut({ ok: false, error: denied })
        try {
          const st = lstatSync(p)
          return jsonOut({
            ok: true,
            path: p,
            type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
            size: st.size,
            mtime: st.mtime.toISOString(),
            isSymlink: st.isSymbolicLink(),
          })
        } catch {
          return jsonOut({ ok: false, error: '路径不存在：' + p })
        }
      },
      summarize: () => '查看路径',
    },
    {
      name: 'backup_add_path',
      description:
        '把一个需要进快照的路径加入快照。两种用途：\n' +
        '① 插件本体之外的**外部文件**（数据目录、自定义 skill 根、MCP 脚本/工作目录、preset 源文件）→ kind 用 plugin-data/skill/mcp/preset/config/external；\n' +
        '② **插件代码本体**（仅当该插件不可再下载、且 Host 自动收集漏掉时才用）→ kind=plugin-code，路径必须是清单里该插件的 codeDir 或其子路径。\n' +
        '注意：可再下载（registry/git/DSH 安装自带）的插件代码默认不进包，只需在恢复计划里写清重装 spec。每加一个都要写清 why。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: '绝对路径（文件或目录）' },
          kind: {
            type: 'string',
            enum: ['plugin-data', 'skill', 'mcp', 'preset', 'config', 'external', 'credentials', 'plugin-code'],
            description: '内容类别：插件数据目录/自定义 skill/MCP 相关/preset 相关/配置文件/其它外部文件',
          },
          why: { type: 'string', description: '为什么恢复时需要它（一句话）' },
          target: { type: 'string', description: '恢复目标串（一般不用填，Host 会自动编码成 $DSH_HOME/... 或绝对路径）' },
          note: { type: 'string', description: '附加说明（可选）' },
        },
        required: ['path', 'kind', 'why'],
      },
      async execute(args = {}) {
        const result = collector.addPath(String(args.path || ''), {
          kind: args.kind,
          why: args.why,
          target: args.target,
          note: args.note,
        })
        if (result.ok && !result.already) {
          log('已加入外部文件：' + displayPath(result.path, env) + '（' + (result.files || 0) + ' 个文件、' + (result.bytes || 0) + ' 字节）')
        }
        return jsonOut(result)
      },
      summarize: (v) => {
        try {
          const j = JSON.parse(v)
          return j.ok ? (j.already ? '已包含：' + (j.message || '') : '已加入：' + displayPath(j.path, env)) : '加入失败：' + (j.error || '')
        } catch {
          return '加入外部路径'
        }
      },
    },
    {
      name: 'backup_remove_path',
      description: '把一个已经加入的外部条目从快照中移除（只按精确路径匹配）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', description: '绝对路径（必须是已加入的条目）' } },
        required: ['path'],
      },
      async execute(args = {}) {
        return jsonOut(collector.removePath(String(args.path || '')))
      },
      summarize: () => '移除外部路径',
    },
    {
      name: 'backup_set_restore_plan',
      description:
        '写入结构化恢复计划（会被保存进快照包的 restore-plan.json，恢复 AI 会照着执行）。务必在 backup_build 之前调用一次。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan: {
            type: 'object',
            description:
              '恢复计划对象。建议结构：{ steps:[{id,title,description,commands?:string[],targets?:string[]}], files:[{source,target,kind,note}], plugins:[{name,version,source,installSpec,note}], mcp:[...], presets:[...], warnings:[...] }',
          },
        },
        required: ['plan'],
      },
      async execute(args = {}) {
        const plan = args.plan && typeof args.plan === 'object' ? args.plan : null
        if (!plan) return jsonOut({ ok: false, error: 'plan 必须是对象' })
        setRestorePlan(plan)
        log('已写入恢复计划（' + (Array.isArray(plan.steps) ? plan.steps.length : 0) + ' 个步骤）')
        return jsonOut({ ok: true, stored: true })
      },
      summarize: () => '写入恢复计划',
    },
    {
      name: 'backup_write_restore_doc',
      description:
        '写 RESTORE.md 的正文（Markdown，中文）。Host 会自动把它与快照元信息、文件清单、固定恢复步骤拼装成最终 RESTORE.md。内容至少要覆盖：恢复步骤、需要放回的位置、插件如何重装、需要重启 DSH、风险与注意事项。上限 200000 字符。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { markdown: { type: 'string', description: 'RESTORE.md 正文（Markdown）' } },
        required: ['markdown'],
      },
      async execute(args = {}) {
        const doc = String(args.markdown || '')
        if (!doc.trim()) return jsonOut({ ok: false, error: 'markdown 为空' })
        setRestoreDoc(doc.slice(0, 200000))
        log('已写入 RESTORE.md 正文（' + doc.length + ' 字符）')
        return jsonOut({ ok: true, chars: doc.length })
      },
      summarize: () => '写入恢复说明',
    },
    {
      name: 'backup_log',
      description: '往界面输出窗口写一条普通日志（告诉用户你在做什么，不影响进度条）。适合每完成一个小步骤说一句。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { type: 'string', description: '一句话说明' } },
        required: ['message'],
      },
      async execute(args = {}) {
        const message = String(args.message || '').slice(0, 500)
        log('AI：' + message)
        return '已记录'
      },
      summarize: () => '记录日志',
    },
    {
      name: 'backup_build',
      description:
        '【最后一步】生成快照：把已收集的文件写入暂存区、写 manifest / RESTORE.md / restore-plan，然后 Brotli 高压缩打包到 ./backup/<时间>.backup.tar.br，并登记到记录文件。调用前必须已经调用过 backup_set_restore_plan 与 backup_write_restore_doc。调用后本次快照即结束。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', description: '一句话总结这次快照包含什么（给用户看）' },
        },
      },
      async execute(args = {}) {
        setProgress({ progress: 82, phase: '写入清单', message: '正在生成 manifest 与恢复说明' })
        const result = await buildArchive({ summary: String(args.summary || '') })
        if (!result || result.ok === false) return jsonOut({ ok: false, error: (result && result.error) || '打包失败' })
        return jsonOut(result)
      },
      summarize: (v) => {
        try {
          const j = JSON.parse(v)
          return j.ok ? '打包完成：' + j.file + '（' + j.sizeText + '）' : '打包失败：' + (j.error || '')
        } catch {
          return '打包完成'
        }
      },
    },
  ]

  return { tools, inventorySummary }
}
