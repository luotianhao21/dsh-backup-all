// dsh-backup-all · 运行编排
//
// 一次「快照」或「恢复」= 一个 run：
//   run 状态（running/done/interrupted/failed）、进度、阶段、输出行都在这里维护，UI 轮询 /state 与 /log。
//   AI 只通过工具改进度、加文件、写说明；真正的复制、压缩、记录、清理都由 Host 做。
//
// 关键流程：
//   快照：扫描 → 收集 → AI 分析/补外部文件/写说明 → 打包 → 登记记录
//   恢复：先做「恢复前快照」（只保留一个）→ 解包 → 比对 → AI 恢复 → 重装依赖（可选）→ 完成

import {
  mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, renameSync, unlinkSync, readdirSync, lstatSync,
  createReadStream,
} from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'

import { resolveEnv, snapshotStamp, defaultSnapshotName, isInside } from './paths.js'
import { createStore, isAiConfigured, publicAiSettings, publicSnapshotSettings } from './store.js'
import { scanInventory } from './inventory.js'
import { createCollector, formatBytes } from './collect.js'
import { createAiClient, testAiConnection, runToolLoop, AiAbortError } from './ai.js'
import { createSnapshotTools } from './tools-snapshot.js'
import { createRestoreTools } from './tools-restore.js'
import { buildCompatibility } from './compatibility.js'
import { packDirectoryBrotli, extractArchive, listArchive } from './archive.js'
import {
  SNAPSHOT_SYSTEM_PROMPT, RESTORE_SYSTEM_PROMPT, INTERRUPT_INSTRUCTION,
  renderSnapshotUserPrompt, renderRestoreUserPrompt,
} from './prompts.js'
import {
  detectOsType, snapshotFileName, sanitizeFileStem, runCommand, osTypeFromName,
} from './platform.js'
const MAX_LOGS = 500
const SNAPSHOT_DEADLINE_MS = 60 * 60 * 1000
const RESTORE_DEADLINE_MS = 45 * 60 * 1000
const PRE_RESTORE_NAME = '恢复前快照'
const PRE_RESTORE_DESC = '恢复前自动快照：用于恢复中断时回滚，或恢复完成后重新还原当前环境'

function readPluginVersion(pluginRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
    return String(pkg.version || '1.0.0')
  } catch {
    return '1.0.0'
  }
}

function tailText(text, max = 4000) {
  const s = String(text || '')
  return s.length <= max ? s : '…' + s.slice(-max)
}

function countFilesInDir(dir, limit = 2000) {
  let count = 0
  const walk = (p, depth) => {
    if (count >= limit || depth > 30) return
    let names
    try {
      names = readdirSync(p)
    } catch {
      return
    }
    for (const name of names) {
      if (count >= limit) return
      const abs = join(p, name)
      try {
        const st = statSync(abs)
        if (st.isDirectory()) walk(abs, depth + 1)
        else count++
      } catch {}
    }
  }
  walk(dir, 0)
  return count
}

export function createBackupRuntime(ctx, config = {}) {
  const env = resolveEnv(config?.paths || {})
  const store = createStore(env)
  // 测试钩子：e2e 测试用假实现替换真实依赖安装，避免在 fixture 目录里跑 pnpm/dsh
  const reinstallOverride =
    config && config.testHooks && typeof config.testHooks.reinstallDependencies === 'function'
      ? config.testHooks.reinstallDependencies
      : null
  const runReinstall = (timeoutMs) => (reinstallOverride ? reinstallOverride(timeoutMs) : reinstallDependencies(timeoutMs))
  const version = readPluginVersion(env.pluginRoot)

  let run = null
  let disposed = false

  // 启动时清掉上次进程/重载残留的临时目录（run 不会跨进程存活，旧缓存一定是垃圾）
  try {
    const cacheRoot = env.cacheDir
    if (existsSync(cacheRoot)) {
      for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          try {
            rmSync(join(cacheRoot, entry.name), { recursive: true, force: true })
          } catch {}
        }
      }
    }
  } catch {}

  // ── 外部信息（服务可缺失，全部兜底） ────────────────────────────────
  async function listBundles() {
    try {
      const pm = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined
      if (pm && typeof pm.listBundles === 'function') return await pm.listBundles()
    } catch {}
    return undefined
  }

  function listWorkspaces() {
    const list = []
    const seen = new Set()
    const push = (w) => {
      if (!w || !w.path) return
      const key = String(w.path)
      if (seen.has(key)) return
      seen.add(key)
      list.push({ id: w.id || '', name: w.name || w.title || '', path: String(w.path) })
    }
    try {
      const reg = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
      const items = reg && typeof reg.list === 'function' ? reg.list() : []
      for (const w of items || []) push(w)
    } catch {}
    // 当前进程 cwd 也当候选（项目级 .dsh/skills 可能在 session 的 cwd 下）
    try {
      if (process.cwd() && !isInside(env.dshHome, process.cwd())) push({ id: '__cwd__', name: '当前目录', path: process.cwd() })
    } catch {}
    return list
  }

  function findInstallationNodeModules() {
    const candidates = []
    try {
      const req = createRequire(import.meta.url)
      const pkgPath = req.resolve('@deepseek-ai/dsh/package.json')
      candidates.push(join(pkgPath, '..', '..', '..'))
    } catch {}
    candidates.push('/opt/dshapp/runtime/node_modules')
    for (const candidate of candidates) {
      try {
        if (existsSync(join(candidate, '@deepseek-ai', 'dsh', 'package.json'))) return candidate
      } catch {}
    }
    return candidates[candidates.length - 1]
  }

  // ── run 生命周期 ────────────────────────────────────────────────────
  function makeRun(kind, extra = {}) {
    return {
      id: randomUUID(),
      kind,
      status: 'running',
      progress: 0,
      phase: '准备',
      message: '',
      snapshotName: extra.snapshotName || '',
      targetRecordId: extra.targetRecordId || '',
      startedAt: new Date().toISOString(),
      endedAt: null,
      error: null,
      logs: [],
      seq: 0,
      assistantOpen: false,
      controller: new AbortController(),
      cacheDir: join(env.cacheDir, 'run-' + randomUUID()),
      summary: '',
    }
  }

  function cleanupRunCache(target) {
    try {
      if (target && target.cacheDir) rmSync(target.cacheDir, { recursive: true, force: true })
    } catch {}
  }

  function publicRun() {
    if (!run) return null
    return {
      id: run.id,
      kind: run.kind,
      status: run.status,
      progress: Math.round(Number(run.progress) || 0),
      phase: run.phase || '',
      message: run.message || '',
      snapshotName: run.snapshotName || '',
      targetRecordId: run.targetRecordId || '',
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      error: run.error,
      outputCursor: run.seq,
      canAbort: run.status === 'running',
      summary: run.summary || '',
    }
  }

  function pushLog(kind, text) {
    if (!run) return
    const line = { seq: ++run.seq, kind, text: String(text == null ? '' : text).slice(0, 6000) }
    run.logs.push(line)
    if (run.logs.length > MAX_LOGS) run.logs.splice(0, run.logs.length - MAX_LOGS)
    if (kind !== 'assistant') run.assistantOpen = false
  }

  function appendAssistant(delta) {
    if (!run || !delta) return
    const last = run.logs[run.logs.length - 1]
    if (last && last.kind === 'assistant' && run.assistantOpen && last.text.length < 6000) {
      last.text = (last.text + delta).slice(0, 6000)
    } else {
      pushLog('assistant', delta)
      run.assistantOpen = true
    }
  }

  function setProgress(patch = {}) {
    if (!run) return
    if (patch.progress != null) {
      const next = Math.max(0, Math.min(100, Number(patch.progress) || 0))
      // 运行中的进度只允许前进：Host 阶段与 AI 进度各自有映射区间，偶发回退会让用户以为卡住/倒退
      if (run.status !== 'running' || next >= run.progress) run.progress = next
    }
    if (patch.phase) run.phase = String(patch.phase).slice(0, 60)
    if (patch.message != null) run.message = String(patch.message).slice(0, 300)
  }

  function finishRun(status, error, summary) {
    if (!run) return
    run.status = status
    if (status === 'done') run.progress = 100
    run.endedAt = new Date().toISOString()
    run.error = error || null
    if (summary) run.summary = String(summary).slice(0, 8000)
    run.controller = null
    try {
      cleanupRunCache(run)
    } catch {}
  }

  function isAbortError(error) {
    return Boolean(error && (error.name === 'AiAbortError' || error.kind === 'aborted' || error.name === 'AbortError'))
  }

  // ── AI 事件 → 输出窗口 ─────────────────────────────────────────────
  function onAiEvent(event, label) {
    if (!event) return
    switch (event.type) {
      case 'assistant-delta':
        appendAssistant(event.text)
        break
      case 'tool-start': {
        run.assistantOpen = false
        const args = event.args || {}
        const hint = args.path || args.message || args.phase || (args.progress != null ? args.progress + '%' : '')
        pushLog('tool', '▸ ' + event.name + (hint ? ' · ' + String(hint).slice(0, 120) : ''))
        break
      }
      case 'tool-result':
        run.assistantOpen = false
        if (event.summary) pushLog('tool', '  ' + String(event.summary).slice(0, 300))
        break
      case 'warn':
        pushLog('system', '⚠ ' + String(event.text || ''))
        break
      case 'error':
        pushLog('error', String(event.text || ''))
        break
      case 'finished':
        run.assistantOpen = false
        break
      default:
        break
    }
  }

  // ── 快照核心（可被独立快照、恢复前快照复用） ───────────────────────
  async function snapshotCore(target, opts) {
    const {
      name, description, recordKind = 'snapshot', tag = 'main',
      progressBase = 0, progressSpan = 100,
    } = opts
    const mapProgress = (p) => progressBase + (Math.max(0, Math.min(100, Number(p) || 0)) / 100) * progressSpan
    const sp = (patch) => {
      if (!run) return
      const patch2 = { ...patch }
      if (patch2.progress != null) patch2.progress = mapProgress(patch2.progress)
      setProgress(patch2)
    }
    const log = (text) => pushLog('system', text)

    const stagingDir = join(target.cacheDir, 'snapshot-' + tag)
    mkdirSync(stagingDir, { recursive: true })

    sp({ progress: 2, phase: '准备暂存目录', message: '创建本次快照的工作目录' })

    // 1) 扫描
    const bundles = await listBundles()
    const workspaces = listWorkspaces()
    const inventory = await scanInventory({
      dshHome: env.dshHome,
      profileDir: env.profileDir,
      profileName: env.profileName,
      homeDir: env.homeDir,
      bundles,
      workspaces,
      installationNodeModules: findInstallationNodeModules(),
      pluginPackageName: 'dsh-backup-all',
    })
    log(
      '扫描完成：' + (inventory.bundles || []).length + ' 个 bundle、' +
      (inventory.plugins || []).length + ' 个插件包、' + (inventory.skills || []).length + ' 个 Skill、' +
      (inventory.mcpRows || []).length + ' 个 MCP 行、' + (inventory.presetRows || []).length + ' 个 Preset 行',
    )
    if (Array.isArray(inventory.warnings) && inventory.warnings.length) {
      log('扫描告警 ' + inventory.warnings.length + ' 条（不影响快照，详情在 manifest）')
    }

    // 2) 收集基线（插件代码打包 / 凭据是否入包 → 由高级设置里的快照策略决定）
    const settings = store.readSettings()
    const snapshotPolicy = publicSnapshotSettings(settings.snapshot)
    sp({ progress: 12, phase: '整理 DSH 配置', message: '收集配置文件 / Skill / 凭据 / 插件代码 / 外部候选' })
    const collector = createCollector({
      env,
      inventory,
      workspaces,
      stagingDir,
      log,
      options: {
        packPluginCode: snapshotPolicy.packPluginCode,
        excludeCredentials: snapshotPolicy.excludeCredentials,
      },
    })
    log('基线条目：' + collector.entries.length + ' 个，合计 ' + formatBytes(collector.sizeSummary.bytes))

    // 3) AI
    const aiSettings = settings.ai
    if (!isAiConfigured(aiSettings)) throw new Error('请先在「高级设置」中配置 AI 模型')
    const client = createAiClient(aiSettings)
    let restorePlan = null
    let restoreDoc = ''
    let built = null

    const buildArchive = async ({ summary } = {}) => {
      sp({ progress: 80, phase: '生成清单', message: '写入 manifest / RESTORE.md / restore-plan' })
      // 包名先定下来（RESTORE.md 里要展示），再生成清单与打包
      mkdirSync(env.backupDir, { recursive: true })
      const stamp = snapshotStamp(new Date())
      const osType = env.osType || detectOsType(process.platform)
      let file = snapshotFileName(stamp, osType)
      let n = 1
      while (existsSync(join(env.backupDir, file))) {
        const ext = '.backup.tar.br'
        file = snapshotFileName(stamp, osType).replace(ext, '-' + n + ext)
        n++
      }
      const builtData = await collector.build({
        snapshot: { name, description, kind: recordKind, file },
        restorePlan,
        aiDoc: restoreDoc,
      })
      sp({ progress: 86, phase: '高压缩打包', message: 'Brotli 压缩中（文件越多越慢）' })
      const outFile = join(env.backupDir, file)
      let packResult
      try {
        packResult = await packDirectoryBrotli({
          sourceDir: stagingDir,
          outFile,
          signal: target.controller ? target.controller.signal : undefined,
          onProgress: (p) => {
            if (p && typeof p.percent === 'number') {
              sp({ progress: 86 + Math.round((p.percent / 100) * 10), phase: '高压缩打包', message: '已压缩 ' + Math.round(p.percent) + '%' })
            }
          },
        })
      } catch (error) {
        try {
          if (existsSync(outFile)) unlinkSync(outFile)
        } catch {}
        throw error
      }
      sp({ progress: 97, phase: '登记快照', message: '写入记录文件' })
      let records = store.readRecords()
      const oldPreRestore = recordKind === 'pre-restore' ? records.filter((r) => r.kind === 'pre-restore') : []
      if (recordKind === 'pre-restore') records = records.filter((r) => r.kind !== 'pre-restore')
      const record = {
        id: randomUUID(),
        name: String(name || ''),
        description: String(description || ''),
        createdAt: new Date().toISOString(),
        file,
        bytes: Number(packResult.bytes) || 0,
        archived: false,
        kind: recordKind,
        osType: env.osType || detectOsType(process.platform),
      }
      records.push(record)
      // 先落新记录（原子写），成功后再删旧「恢复前快照」文件：任何一步失败都不会出现「没有任何可用恢复前快照」
      store.writeRecords(records)
      for (const old of oldPreRestore) {
        try {
          store.deleteArchiveFile(old)
        } catch {}
      }
      built = {
        ok: true,
        file,
        path: outFile,
        sizeText: formatBytes(packResult.bytes),
        bytes: packResult.bytes,
        rawBytes: packResult.rawBytes,
        compressedPercent: Math.round((packResult.bytes / Math.max(1, packResult.rawBytes)) * 100),
        entries: builtData.entries,
        fileCount: builtData.fileCount,
        recordId: record.id,
        summary: String(summary || '').slice(0, 500),
      }
      pushLog('system', '快照包已生成：' + file + '（' + built.sizeText + '，原始 ' + formatBytes(packResult.rawBytes) + '，压缩到 ' + built.compressedPercent + '%）')
      return built
    }

    // AI 的 0-100 映射到本次快照区间的 20%-78%；Host 固定阶段用 sp，打包用 buildArchive 里的 sp
    const aiSp = (patch = {}) => sp({ ...patch, progress: patch.progress != null ? 20 + (Math.max(0, Math.min(100, Number(patch.progress) || 0)) / 100) * 58 : undefined })
    const { tools, inventorySummary } = createSnapshotTools({
      env,
      inventory,
      collector,
      workspaces,
      run: target,
      setProgress: aiSp,
      policy: snapshotPolicy,
      log,
      setRestorePlan: (plan) => {
        restorePlan = plan
      },
      setRestoreDoc: (doc) => {
        restoreDoc = doc
      },
      buildArchive,
    })

    const userPrompt = renderSnapshotUserPrompt({
      snapshotName: name,
      description,
      environment: {
        osType: env.osType,
        platform: env.platform,
        arch: env.arch,
        osRelease: env.osRelease,
        nodeVersion: env.nodeVersion,
      },
      inventory: inventorySummary,
      config: {
        version,
        dshHome: env.dshHome,
        profileName: env.profileName,
        profileDir: env.profileDir,
        pluginRoot: env.pluginRoot,
        backupDir: env.backupDir,
        workspaces,
        credentialsIncluded: !snapshotPolicy.excludeCredentials,
        packPluginCode: snapshotPolicy.packPluginCode,
        pluginCodeIncluded: snapshotPolicy.packPluginCode !== 'none',
      },
    })

    sp({ progress: 20, phase: 'AI 分析', message: '模型开始阅读安装项清单' })
    const result = await runToolLoop({
      client,
      system: SNAPSHOT_SYSTEM_PROMPT,
      user: userPrompt,
      tools,
      signal: target.controller.signal,
      onEvent: (event) => onAiEvent(event, 'snapshot'),
      options: {
        maxIterations: 80,
        deadlineMs: SNAPSHOT_DEADLINE_MS,
        getFinished: () => Boolean(built),
      },
    })
    if (!built) {
      if (result && result.aborted) throw new AiAbortError('用户中断')
      throw new Error(result && result.error ? String(result.error) : 'AI 未调用 backup_build，快照未生成')
    }
    return built
  }

  // ── 快照入口 ────────────────────────────────────────────────────────
  async function executeSnapshotRun(target, { name, description }) {
    try {
      const built = await snapshotCore(target, { name, description, recordKind: 'snapshot', tag: 'main', progressBase: 0, progressSpan: 100 })
      if (!run || run !== target) return
      target.summary = '快照已完成：' + built.file + '（' + built.sizeText + '）'
      finishRun('done', null, target.summary)
      pushLog('system', '✓ 快照完成：' + built.file + '（' + built.sizeText + '）')
    } catch (error) {
      if (!run || run !== target) return
      if (isAbortError(error)) {
        pushLog('system', '已停止 AI 与打包流程，清理本次缓存与半成品文件')
        finishRun('interrupted', null, '快照已被用户中断')
      } else {
        pushLog('error', String((error && error.message) || error))
        finishRun('failed', String((error && error.message) || error))
      }
    }
  }

  function startSnapshot({ name, description }) {
    if (disposed) return { ok: false, error: '插件已卸载' }
    if (run && run.status === 'running') return { ok: false, error: '已有任务正在运行，请等待完成或先中断' }
    const ai = store.readSettings().ai
    if (!isAiConfigured(ai)) return { ok: false, error: '请先在「高级设置」中配置 AI 模型（Base URL / API Key / Model ID）' }
    const cleanName = String(name || '').trim().slice(0, 200) || defaultSnapshotName()
    const cleanDesc = String(description || '').trim().slice(0, 2000)
    run = makeRun('snapshot', { snapshotName: cleanName })
    const target = run
    pushLog('system', '开始创建快照「' + cleanName + '」')
    executeSnapshotRun(target, { name: cleanName, description: cleanDesc }).catch((error) => {
      try {
        if (run === target) pushLog('error', '快照流程异常结束：' + String((error && error.message) || error))
      } catch {}
    })
    return { ok: true, runId: target.id }
  }

  // ── 恢复入口 ────────────────────────────────────────────────────────
  async function reinstallDependencies(timeoutMs) {
    const attempts = [
      { cmd: 'dsh', args: ['plugin', '--profile', env.profileName, 'install'], cwd: env.profileDir },
      { cmd: 'pnpm', args: ['install'], cwd: env.profileDir },
    ]
    let last = null
    for (const attempt of attempts) {
      try {
        const { stdout, stderr } = await runCommand(attempt.cmd, attempt.args, {
          cwd: attempt.cwd,
          timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          env: process.env,
          signal: run?.controller ? run.controller.signal : undefined,
        })
        return {
          ok: true,
          command: attempt.cmd + ' ' + attempt.args.join(' '),
          exitCode: 0,
          outputTail: tailText(String(stdout || '') + String(stderr || '')),
        }
      } catch (error) {
        last = error
        if (error && (error.code === 'ENOENT' || /ENOENT|not recognized|不是内部或外部命令|CommandNotFoundException/i.test(String(error.message || '')))) continue
        return {
          ok: false,
          command: attempt.cmd + ' ' + attempt.args.join(' '),
          exitCode: typeof error.code === 'number' ? error.code : -1,
          error: String((error && error.message) || error),
          outputTail: tailText(String(error.stdout || '') + String(error.stderr || '')),
        }
      }
    }
    return { ok: false, command: '', error: '找不到 dsh 或 pnpm 命令：' + String((last && last.message) || '') }
  }

  /** 只保留最近 5 次恢复的安全备份目录，避免无限增长 */
  function pruneRestoreSafety() {
    try {
      const root = join(env.dataDir, 'restore-safety')
      if (!existsSync(root)) return
      const dirs = []
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        try {
          dirs.push({ name: entry.name, mtime: statSync(join(root, entry.name)).mtimeMs })
        } catch {}
      }
      dirs.sort((a, b) => b.mtime - a.mtime)
      for (const dir of dirs.slice(5)) {
        try {
          rmSync(join(root, dir.name), { recursive: true, force: true })
        } catch {}
      }
    } catch {}
  }

  async function executeRestoreRun(target, record) {
    try {
      // 当前恢复设置：跨 OS 插件代码策略（skip | js）
      const restoreSnapshotPolicy = publicSnapshotSettings(store.readSettings().snapshot)
      const crossOsPluginCode = restoreSnapshotPolicy.crossOsPluginCode === 'js' ? 'js' : 'skip'
      // 1) 恢复前快照（只保留一个）
      pushLog('system', '恢复前先为当前环境创建「' + PRE_RESTORE_NAME + '」')
      setProgress({ progress: 2, phase: '创建恢复前快照', message: '先保存当前环境，便于回滚' })
      const pre = await snapshotCore(target, {
        name: PRE_RESTORE_NAME,
        description: PRE_RESTORE_DESC,
        recordKind: 'pre-restore',
        tag: 'pre-restore',
        progressBase: 3,
        progressSpan: 32,
      })
      if (!run || run !== target) return
      pushLog('system', '恢复前快照已保存：' + pre.file + '（' + pre.sizeText + '）')

      // 2) 解包
      setProgress({ progress: 37, phase: '解包快照', message: '解压到临时目录' })
      const extractDir = join(target.cacheDir, 'extracted')
      mkdirSync(extractDir, { recursive: true })
      const extractResult = await extractArchive({
        archiveFile: join(env.backupDir, record.file),
        destDir: extractDir,
        signal: target.controller.signal,
        symlinkPolicy: 'auto',
      })
      if (extractResult && Array.isArray(extractResult.warnings) && extractResult.warnings.length) {
        pushLog('system', '解包警告：' + extractResult.warnings.slice(0, 5).join('；'))
      }
      const readJson = (name, fallback) => {
        try {
          return JSON.parse(readFileSync(join(extractDir, name), 'utf8'))
        } catch {
          return fallback
        }
      }
      const manifest = readJson('manifest.json', null)
      if (!manifest) throw new Error('快照包缺少 manifest.json，无法恢复')
      // 跨 OS 兼容恢复：读取 manifest 后计算 compatibility，并跳过符号链接/junction 条目
      let restoreCompatibility = null
      try {
        restoreCompatibility = buildCompatibility(manifest.environment || {}, {
          osType: env.osType || detectOsType(process.platform),
          platform: env.platform,
          arch: env.arch,
          dshHome: env.dshHome,
          profileDir: env.profileDir,
        }, { crossOsPluginCode })
      } catch {}
      const crossCompat = restoreCompatibility && (restoreCompatibility.strategy === 'compat-linux-to-windows' || restoreCompatibility.strategy === 'compat-windows-to-linux')
      if (crossCompat) {
        let removedLinks = 0
        const walkPrune = (dir) => {
          let ents
          try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
          for (const ent of ents) {
            const abs = join(dir, ent.name)
            try {
              const st = lstatSync(abs)
              if (st.isSymbolicLink()) { rmSync(abs, { force: true }); removedLinks += 1; continue }
              if (st.isDirectory()) walkPrune(abs)
            } catch {}
          }
        }
        walkPrune(extractDir)
        if (removedLinks > 0) pushLog('system', '跨 OS：已跳过 ' + removedLinks + ' 个符号链接/junction 条目')
      }
      const plan = readJson('restore-plan.json', null)
      let restoreDoc = ''
      try {
        restoreDoc = readFileSync(join(extractDir, 'RESTORE.md'), 'utf8')
      } catch {}
      setProgress({ progress: 43, phase: '分析快照内容', message: '读取快照说明与文件清单' })
      pushLog('system', '快照包含 ' + (manifest.entries || []).length + ' 个文件条目、' + (manifest.plugins || []).length + ' 个插件记录')

      // 3) AI 恢复
      const aiSettings = store.readSettings().ai
      if (!isAiConfigured(aiSettings)) throw new Error('当前没有可用的 AI 配置，无法驱动恢复')
      const client = createAiClient(aiSettings)
      let finished = false
      let finishSummary = ''
      const safetyDir = join(env.dataDir, 'restore-safety', target.id)
      mkdirSync(safetyDir, { recursive: true })
      pruneRestoreSafety()
      const restoreSp = (patch = {}) => setProgress({
        ...patch,
        progress: patch.progress != null ? 43 + (Math.max(0, Math.min(100, Number(patch.progress) || 0)) / 100) * 55 : undefined,
      })
      const { tools } = createRestoreTools({
        env,
        extractedDir: extractDir,
        safetyDir,
        manifest,
        plan,
        restoreDoc,
        workspaces: listWorkspaces(),
        setProgress: restoreSp,
        log: (text) => pushLog('system', text),
        setFinished: (summary) => {
          finished = true
          finishSummary = String(summary || '')
        },
        reinstallDependencies: runReinstall,
        restoreOptions: { crossOsPluginCode },
      })
      let currentBundles = []
      try {
        currentBundles = (await listBundles()) || []
      } catch {}
      const userPrompt = renderRestoreUserPrompt({
        recordName: record.name,
        description: record.description,
        environment: {
          osType: env.osType,
          platform: env.platform,
          arch: env.arch,
          osRelease: env.osRelease,
          nodeVersion: env.nodeVersion,
          crossOsPluginCode,
        },
        archivePath: join(env.backupDir, record.file),
        manifest,
        restorePlan: plan,
        currentInventory: {
          profileName: env.profileName,
          dshHome: env.dshHome,
          profileDir: env.profileDir,
          bundles: currentBundles.map((b) => ({ name: b.name, version: b.version, enabled: b.enabled })),
        },
      })
      const result = await runToolLoop({
        client,
        system: RESTORE_SYSTEM_PROMPT,
        user: userPrompt,
        tools,
        signal: target.controller.signal,
        onEvent: (event) => onAiEvent(event, 'restore'),
        options: {
          maxIterations: 60,
          deadlineMs: RESTORE_DEADLINE_MS,
          getFinished: () => finished,
        },
      })
      if (!finished) {
        if (result && result.aborted) throw new AiAbortError('用户中断')
        throw new Error(result && result.error ? String(result.error) : 'AI 未调用 restore_finish，恢复未完成')
      }
      if (!run || run !== target) return

      // 用户明确要求：恢复 AI 应自动重装依赖；Host 在最后再「机械性地」强制执行一次，
      // 不依赖 AI 是否调用过 restore_reinstall_dependencies（幂等：dsh plugin install / pnpm install）。
      setProgress({ progress: 98, phase: '安装依赖', message: 'Host 强制执行一次依赖安装（机械性收尾）' })
      if (restoreCompatibility && restoreCompatibility.strategy === 'blocked') {
        pushLog('system', '跨 OS 策略为 blocked：未写回任何文件，跳过 Host 强制依赖安装')
        target.summary = finishSummary + '\n\n依赖安装：跨 OS（Windows→Linux）blocked，未执行写回与依赖安装。'
        finishRun('done', null, target.summary)
        pushLog('system', '✓ 恢复结束：未执行任何写回（跨 OS 不支持）')
        return
      }
      pushLog('system', '按要求由 Host 强制执行依赖安装：dsh plugin --profile ' + env.profileName + ' install（失败回退 pnpm install）')
      let installNote = ''
      try {
        const installResult = await runReinstall(5 * 60 * 1000)
        if (installResult && installResult.ok) {
          installNote = '\n\n依赖安装：Host 已在恢复末尾强制执行一次（' + (installResult.command || '') + '），成功。'
          pushLog('system', '依赖安装成功：' + (installResult.command || ''))
        } else {
          const reason = (installResult && (installResult.error || ('exit ' + installResult.exitCode))) || '未知错误'
          installNote = '\n\n⚠ 依赖安装：Host 在恢复末尾强制执行的安装失败（' + reason + '）；请手动执行 `dsh plugin --profile ' + env.profileName + ' install`。'
          pushLog('error', '依赖安装失败：' + reason)
        }
      } catch (installError) {
        const reason = String((installError && installError.message) || installError)
        installNote = '\n\n⚠ 依赖安装：Host 强制安装抛错（' + reason + '）；请手动执行 `dsh plugin --profile ' + env.profileName + ' install`。'
        pushLog('error', '依赖安装异常：' + reason)
      }
      target.summary = finishSummary + installNote
      finishRun('done', null, target.summary)
      pushLog('system', '✓ 恢复完成。部分插件变更需要重启 DSH 后生效。')
    } catch (error) {
      if (!run || run !== target) return
      if (isAbortError(error)) {
        pushLog('system', '已停止恢复流程并清理缓存；已创建的「' + PRE_RESTORE_NAME + '」可用于回滚')
        finishRun('interrupted', null, '恢复已被用户中断')
      } else {
        pushLog('error', String((error && error.message) || error))
        finishRun('failed', String((error && error.message) || error))
      }
    }
  }

  function startRestore({ id }) {
    if (disposed) return { ok: false, error: '插件已卸载' }
    if (run && run.status === 'running') return { ok: false, error: '已有任务正在运行，请等待完成或先中断' }
    const record = store.readRecords().find((r) => r.id === String(id || ''))
    if (!record) return { ok: false, error: '找不到该快照记录（压缩包可能已被删除）' }
    const ai = store.readSettings().ai
    if (!isAiConfigured(ai)) return { ok: false, error: '请先在「高级设置」中配置 AI 模型' }
    run = makeRun('restore', { snapshotName: record.name, targetRecordId: record.id })
    const target = run
    pushLog('system', '开始恢复快照「' + record.name + '」')
    executeRestoreRun(target, record).catch((error) => {
      try {
        if (run === target) pushLog('error', '恢复流程异常结束：' + String((error && error.message) || error))
      } catch {}
    })
    return { ok: true, runId: target.id }
  }

  function abortRun({ runId } = {}) {
    if (!run) return { ok: false, error: '当前没有任务' }
    // 必须带匹配的 runId：否则知道端点的人就能中止任何人的任务（P1-1）
    if (!runId || run.id !== String(runId)) return { ok: false, error: '缺少或无效的 runId' }
    if (run.status !== 'running') return { ok: false, error: '任务已结束' }
    pushLog('system', INTERRUPT_INSTRUCTION)
    if (run.controller) {
      try {
        run.controller.abort()
      } catch {}
    }
    return { ok: true }
  }

  // ── 记录操作 ────────────────────────────────────────────────────────
  function mapRecord(record) {
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      createdAt: record.createdAt,
      file: record.file,
      bytes: record.bytes,
      sizeText: formatBytes(record.bytes),
      archived: record.archived,
      kind: record.kind,
      label: record.kind === 'pre-restore' ? PRE_RESTORE_NAME : '',
      osType: record.osType || 'unknown',
      imported: record.imported === true,
    }
  }

  function editRecord({ id, name, description }) {
    const records = store.readRecords()
    const record = records.find((r) => r.id === String(id || ''))
    if (!record) return { ok: false, error: '找不到该快照' }
    if (name !== undefined) {
      const clean = String(name || '').trim()
      if (!clean) return { ok: false, error: '名称不能为空' }
      record.name = clean.slice(0, 200)
    }
    if (description !== undefined) record.description = String(description || '').slice(0, 2000)
    store.writeRecords(records)
    return { ok: true, record: mapRecord(record) }
  }

  function setArchived({ id, archived }) {
    const records = store.readRecords()
    const record = records.find((r) => r.id === String(id || ''))
    if (!record) return { ok: false, error: '找不到该快照' }
    record.archived = archived !== false
    store.writeRecords(records)
    return { ok: true, record: mapRecord(record) }
  }

  function deleteRecord({ id }) {
    const records = store.readRecords()
    const record = records.find((r) => r.id === String(id || ''))
    if (!record) return { ok: false, error: '找不到该快照' }
    if (!record.archived && record.kind !== 'pre-restore') {
      return { ok: false, error: '只能删除已归档的快照（或恢复前快照）' }
    }
    store.deleteArchiveFile(record)
    store.writeRecords(records.filter((r) => r.id !== record.id))
    return { ok: true }
  }

  function promoteRecord({ id, name, description }) {
    const records = store.readRecords()
    const record = records.find((r) => r.id === String(id || ''))
    if (!record) return { ok: false, error: '找不到该快照' }
    if (record.kind !== 'pre-restore') return { ok: false, error: '只有恢复前快照可以保存为永久快照' }
    const cleanName = String(name || '').trim()
    if (!cleanName) return { ok: false, error: '名称不能为空' }
    record.kind = 'snapshot'
    record.name = cleanName.slice(0, 200)
    record.description = String(description || record.description || '').slice(0, 2000)
    store.writeRecords(records)
    return { ok: true, record: mapRecord(record) }
  }

  function clearAll({ confirm } = {}) {
    if (confirm !== true) return { ok: false, error: '需要确认（confirm: true）' }
    const records = store.readRecords()
    let removed = 0
    for (const record of records) {
      if (store.deleteArchiveFile(record)) removed++
    }
    store.writeRecords([])
    return { ok: true, removed }
  }

  // ── 导入 / 导出（v1.1.0）─────────────────────────────────────────────
  /**
   * 导入外部快照归档。tempFile 为 Host 已落盘的原始字节；校验 brotli+tar+manifest 后
   * 移入 backup/ 并登记记录。校验失败时不留下任何垃圾文件。
   */
  async function importSnapshot({ tempFile, originalFilename, name, description } = {}) {
    const tmp = String(tempFile || '')
    const cleanup = () => {
      try { if (tmp && existsSync(tmp)) unlinkSync(tmp) } catch {}
    }
    try {
      if (!tmp || !existsSync(tmp)) return { ok: false, error: '上传数据为空或写入失败' }
      const rawName = String(originalFilename || '').replace(/[\\/]+/g, '/').split('/').pop() || 'snapshot'
      const ext = /\.tar\.br$/i.test(rawName) ? (/\.backup\.tar\.br$/i.test(rawName) ? '.backup.tar.br' : '.tar.br') : '.backup.tar.br'
      const stem = rawName.toLowerCase().endsWith(ext.toLowerCase()) ? rawName.slice(0, -ext.length) : rawName
      const displayName = String(name || '').trim().slice(0, 200) || stem.slice(0, 200) || '导入的快照'
      const displayDesc = String(description || '').slice(0, 2000)

      // 校验：解包读 manifest（只读，不需要保留内容）
      const probeDir = join(env.cacheDir, 'import-probe-' + randomUUID())
      let manifest = null
      try {
        mkdirSync(probeDir, { recursive: true })
        await extractArchive({ archiveFile: tmp, destDir: probeDir, symlinkPolicy: 'skip' })
        const manifestPath = join(probeDir, 'manifest.json')
        if (!existsSync(manifestPath)) {
          cleanup()
          return { ok: false, error: '不是有效的快照归档：缺少 manifest.json' }
        }
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch (error) {
        cleanup()
        return { ok: false, error: '不是有效的快照归档（Brotli/tar 解包失败）：' + String((error && error.message) || error) }
      } finally {
        try { rmSync(probeDir, { recursive: true, force: true }) } catch {}
      }

      const manifestType = manifest && manifest.environment && manifest.environment.osType
      const osType = ['linux', 'windows', 'other'].includes(String(manifestType)) ? String(manifestType) : (osTypeFromName(rawName) || 'unknown')

      // 文件名：保留原始 name（清洗非法字符/保留名），冲突时加 -n
      const safeStem = sanitizeFileStem(stem)
      let fileName = safeStem + ext
      let n = 1
      while (existsSync(join(env.backupDir, fileName))) {
        fileName = safeStem + '-' + n + ext
        n++
      }
      mkdirSync(env.backupDir, { recursive: true })
      const destPath = join(env.backupDir, fileName)
      // 临时文件在 backup/.cache（同一卷），直接 rename；失败退回复制
      try {
        renameSync(tmp, destPath)
      } catch {
        writeFileSync(destPath, readFileSync(tmp))
        try { unlinkSync(tmp) } catch {}
      }
      const bytes = (() => { try { return statSync(destPath).size } catch { return 0 } })()

      const records = store.readRecords()
      const record = {
        id: randomUUID(),
        name: displayName,
        description: displayDesc,
        createdAt: new Date().toISOString(),
        file: fileName,
        bytes,
        archived: false,
        kind: 'snapshot',
        snapshotId: '',
        osType,
        imported: true,
      }
      records.push(record)
      store.writeRecords(records)
      return { ok: true, record: mapRecord(record) }
    } catch (error) {
      cleanup()
      return { ok: false, error: String((error && error.message) || error) }
    }
  }

  /** 导出：返回记录与磁盘路径（routes 负责流式下发） */
  function getExportInfo({ id } = {}) {
    const records = store.readRecords()
    const record = records.find((r) => r.id === String(id || ''))
    if (!record) return { ok: false, error: '找不到该快照' }
    if (!isInside(env.backupDir, join(env.backupDir, record.file))) return { ok: false, error: '非法的快照文件名' }
    const filePath = join(env.backupDir, record.file)
    if (!existsSync(filePath)) return { ok: false, error: '快照文件不存在' }
    return { ok: true, record: mapRecord(record), file: record.file, path: filePath }
  }

  // ── 设置 ────────────────────────────────────────────────────────────
  const PROTOCOLS = ['openai-completions', 'anthropic-messages']
  const EFFORTS = ['off', 'low', 'high', 'max']

  function mergeAiPatch(current, input) {
    const ai = { ...current }
    if (!input || typeof input !== 'object') return ai
    if (input.baseURL !== undefined) ai.baseURL = String(input.baseURL || '').trim()
    if (input.protocol !== undefined) {
      const protocol = PROTOCOLS.includes(input.protocol) ? input.protocol : 'openai-completions'
      ai.protocol = protocol
    }
    if (input.modelId !== undefined) ai.modelId = String(input.modelId || '').trim()
    if (input.apiKey !== undefined) {
      if (input.apiKey === null) ai.apiKey = ''
      else if (String(input.apiKey).trim()) ai.apiKey = String(input.apiKey).trim()
      // 空字符串 = 保持已保存的 Key 不变
    }
    if (input.contextWindowValue !== undefined) {
      const value = Number(input.contextWindowValue)
      const unit = String(input.contextWindowUnit || 'K').toUpperCase() === 'M' ? 1_000_000 : 1000
      if (Number.isFinite(value) && value > 0) ai.contextWindow = Math.round(value * unit)
    } else if (input.contextWindow !== undefined) {
      const value = Number(input.contextWindow)
      if (Number.isFinite(value) && value > 0) ai.contextWindow = Math.round(value)
    }
    if (input.maxOutputValue !== undefined) {
      const value = Number(input.maxOutputValue)
      const unit = String(input.maxOutputUnit || 'K').toUpperCase() === 'M' ? 1_000_000 : 1000
      if (Number.isFinite(value) && value > 0) ai.maxOutput = Math.round(value * unit)
    } else if (input.maxOutput !== undefined) {
      const value = Number(input.maxOutput)
      if (Number.isFinite(value) && value > 0) ai.maxOutput = Math.round(value)
    }
    if (input.effort !== undefined) ai.effort = EFFORTS.includes(input.effort) ? input.effort : 'max'
    return ai
  }

  function mergeSnapshotPolicy(current, input) {
    const next = { ...publicSnapshotSettings(current) }
    if (!input || typeof input !== 'object') return next
    const raw = input.snapshot && typeof input.snapshot === 'object' ? input.snapshot : input
    if (raw.packPluginCode !== undefined) {
      next.packPluginCode = ['local-only', 'all', 'none'].includes(raw.packPluginCode) ? raw.packPluginCode : 'local-only'
    }
    if (raw.excludeCredentials !== undefined) next.excludeCredentials = raw.excludeCredentials === true
    if (raw.crossOsPluginCode !== undefined) next.crossOsPluginCode = ['skip', 'js'].includes(raw.crossOsPluginCode) ? raw.crossOsPluginCode : 'skip'
    return next
  }

  function saveSettings(input) {
    const current = store.readSettings()
    const ai = mergeAiPatch(current.ai, input)
    const snapshot = mergeSnapshotPolicy(current.snapshot, input)
    store.writeSettings({ ai, snapshot })
    return { ok: true, settings: { ai: publicAiSettings(ai), snapshot } }
  }

  async function testSettings(input) {
    const current = store.readSettings()
    const candidate = mergeAiPatch(current.ai, input)
    if (!isAiConfigured(candidate)) return { ok: false, connected: false, error: 'AI 配置不完整：Base URL / API Key / Model ID 必填' }
    const result = await testAiConnection(candidate)
    // 把“最近一次连通性”记到已保存配置上（表单未保存的字段不落盘）
    const currentAi = store.readSettings().ai
    currentAi.connected = Boolean(result.ok)
    currentAi.connectedAt = new Date().toISOString()
    currentAi.connectDetail = String(result.detail || result.error || '').slice(0, 500)
    store.writeSettings({ ai: currentAi })
    return {
      ok: Boolean(result.ok),
      connected: Boolean(result.ok),
      latencyMs: result.latencyMs,
      detail: String(result.detail || ''),
      error: result.error ? String(result.error) : undefined,
      modelId: candidate.modelId,
    }
  }

  // ── 对外状态 ────────────────────────────────────────────────────────
  function getState() {
    const records = store.listRecords()
    const active = records.filter((r) => !r.archived)
    const archived = records.filter((r) => r.archived)
    return {
      ok: true,
      version,
      currentOs: env.osType || detectOsType(process.platform),
      totalBytes: records.reduce((sum, r) => sum + (Number(r.bytes) || 0), 0),
      backupDir: env.backupDir,
      records: active.map(mapRecord),
      archived: archived.map(mapRecord),
      run: publicRun(),
      settings: {
        ai: publicAiSettings(store.readSettings().ai),
        snapshot: publicSnapshotSettings(store.readSettings().snapshot),
      },
    }
  }

  function getLog({ since = 0, runId = '' } = {}) {
    if (!run) return { ok: true, runId: null, cursor: 0, lines: [] }
    if (runId && String(runId) !== run.id) {
      // 客户端拿的是上一轮 run：把当前 run 的全部行给它，方便重开窗口时对齐
      return { ok: true, runId: run.id, cursor: run.seq, lines: run.logs.slice(-MAX_LOGS) }
    }
    const sinceN = Number(since) || 0
    return {
      ok: true,
      runId: run.id,
      cursor: run.seq,
      lines: run.logs.filter((line) => line.seq > sinceN),
    }
  }

  function dispose() {
    disposed = true
    try {
      if (run && run.status === 'running') {
        pushLog('system', '插件卸载，运行中的任务被中止')
        run.controller && run.controller.abort()
        cleanupRunCache(run)
      }
    } catch {}
  }

  return {
    env,
    version,
    store,
    startSnapshot,
    startRestore,
    abortRun,
    getState,
    getLog,
    editRecord,
    setArchived,
    deleteRecord,
    promoteRecord,
    clearAll,
    importSnapshot,
    getExportInfo,
    saveSettings,
    testSettings,
    getAiSettings: () => store.readSettings().ai,
    getSnapshotSettings: () => publicSnapshotSettings(store.readSettings().snapshot),
    dispose,
    // 测试/维护用
    _internal: { snapshotCore, listWorkspaces, listBundles, collectCountFiles: countFilesInDir },
  }
}
