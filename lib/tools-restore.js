// dsh-backup-all · 恢复 AI 可调用的工具
//
// 恢复时的分工：
//  - Host：解包到暂存区、读取 manifest/计划、提供比对与应用能力、把旧文件安全备份到 .restore-backup。
//  - 恢复 AI：读懂快照说明、判断哪些要恢复、执行 restore_apply_files、必要时重新安装依赖、最后 finish。
//
// 安全底线：只允许恢复 manifest.entries 里登记过的目标；其它路径一律拒绝。

import { existsSync, lstatSync, statSync, mkdirSync, readFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { resolve, join, basename, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolveRestoreTarget, decodeTargetPath } from './paths.js'
import { detectOsType } from './platform.js'
import { buildCompatibility } from './compatibility.js'
import { classifyPluginCodeDir } from './plugin-code.js'

const MAX_JSON_CHARS = 20000
const MAX_TEXT_CHARS = 20000

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function jsonOut(value) {
  let text = JSON.stringify(value)
  if (text.length > MAX_JSON_CHARS) text = text.slice(0, MAX_JSON_CHARS) + '…[结果过长已截断]'
  return text
}

function sha256FileSync(file) {
  try {
    const hash = createHash('sha256')
    hash.update(readFileSync(file))
    return hash.digest('hex')
  } catch {
    return ''
  }
}

function statSafe(p) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

export function createRestoreTools(deps) {
  const {
    env, extractedDir, manifest, plan, restoreDoc, workspaces = [],
    setProgress, log, setFinished, safetyDir,
    restoreOptions = {},
  } = deps
  // 跨 OS 增强：是否允许迁移纯 JS 插件代码（默认 skip）
  const crossOsPluginCode = restoreOptions.crossOsPluginCode === 'js' ? 'js' : 'skip'

  const entries = Array.isArray(manifest?.entries) ? manifest.entries : []
  // 安全备份放在 data/restore-safety/<runId>（不随运行缓存一起删），恢复失败时用户能找回被覆盖的旧文件
  const safetyRoot = safetyDir || join(extractedDir, '.restore-safety')

  // 更强的自动路径重映射：占位符 → 旧根前缀 → workspace basename → fallback 目录
  // （双保险保留在 resolveRestoreTarget 内部：最终目标必须落在允许目录，或与条目原始 source 一致）
  const manifestEnv = { ...(manifest?.environment || {}), workspaces: manifest?.workspaces || manifest?.environment?.workspaces || [] }

  function resolveEntry(entry) {
    return resolveRestoreTarget(entry, manifestEnv, env, workspaces)
  }

  function entryTarget(entry) {
    const resolved = resolveEntry(entry)
    return resolved.ok ? resolved.target : null
  }

  function compareOne(entry) {
    const resolved = resolveEntry(entry)
    const remap = resolved.remapped ? { original: resolved.original, reason: resolved.reason, mode: resolved.mode } : null
    const target = resolved.ok ? resolved.target : null
    if (!target) {
      return {
        archivePath: entry.archivePath,
        target: entry.target,
        source: entry.source,
        kind: entry.kind,
        status: 'unmapped',
        remap,
        reason: resolved.reason || '目标路径无法解析为当前机器路径',
      }
    }
    const st = statSafe(target)
    if (!st) return { archivePath: entry.archivePath, target, source: entry.source, kind: entry.kind, status: 'missing', bytes: entry.bytes || 0, remap }
    if (entry.isDirectory) {
      return { archivePath: entry.archivePath, target, source: entry.source, kind: entry.kind, status: 'present', bytes: entry.bytes || 0, remap }
    }
    if (st.isDirectory()) return { archivePath: entry.archivePath, target, source: entry.source, kind: entry.kind, status: 'different', reason: '当前是目录', remap }
    const same = entry.sha256 ? sha256FileSync(target) === entry.sha256 : statSafe(target)?.size === entry.bytes
    return {
      archivePath: entry.archivePath,
      target,
      source: entry.source,
      kind: entry.kind,
      status: same ? 'same' : 'different',
      bytes: entry.bytes || 0,
      remap,
    }
  }

  function compare() {
    const items = entries.map(compareOne)
    const summary = items.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1
      if (item.remap) acc.remapped = (acc.remapped || 0) + 1
      return acc
    }, {})
    const plugins = (manifest?.plugins || []).map((p) => {
      // 跨机场景：快照机的 packageDir 绝对路径在目标机不存在，不能据此判断 present。
      // 优先看「本插件/该包」在当前目标机是否已安装（profile node_modules），
      // 其次看已入包代码的 codeTarget 在当前机器重映射后是否存在。
      let present = false
      const packageName = String(p.name || '')
      if (packageName) {
        const inProfile = join(env.profileDir, 'node_modules', ...packageName.split('/'))
        if (existsSync(inProfile)) present = true
      }
      if (!present && p.packed === true && p.codeTarget) {
        const decoded = decodeTargetPath(p.codeTarget, env, workspaces)
        if (decoded && existsSync(decoded)) present = true
      }
      if (!present && p.packageDir && existsSync(p.packageDir)) present = true
      return { name: p.name, version: p.version, present, source: p.source || '', bundled: p.bundled || false, packed: p.packed === true }
    })

    // 构造当前环境 → 计算 compatibility
    const snapshotEnvironment = manifest?.environment || {}
    const currentEnvironment = {
      osType: env.osType || detectOsType(process.platform),
      platform: process.platform,
      arch: process.arch,
      dshVersion: env.dshVersion || null,
      nodeVersion: process.version,
      dshHome: env.dshHome,
      profileDir: env.profileDir,
      homeDir: env.homeDir,
      workspaces: workspaces,
    }
    const compatibility = buildCompatibility(snapshotEnvironment, currentEnvironment, { crossOsPluginCode })

    return { ok: true, summary, items, plugins, compatibility }
  }

  async function backupExisting(target, index) {
    try {
      if (!existsSync(target)) return ''
      const dest = join(safetyRoot, String(index).padStart(4, '0') + '_' + basename(target))
      mkdirSync(safetyRoot, { recursive: true })
      const st = lstatSync(target)
      if (st.isDirectory()) await fsp.cp(target, dest, { recursive: true })
      else await fsp.copyFile(target, dest)
      return dest
    } catch {
      return ''
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 自保：恢复 profile 的 package.json / cordis.patch.yml 时，自动保留
  // 「dsh-backup-all」自身的依赖与 Loader 插入行。
  // 原因：若恢复的快照生成于本插件安装之前，直接覆盖会把正在执行恢复的
  // 本插件从 Loader 树上摘掉（HMR 重组合），导致恢复流程中断、UI 丢失完成态。
  // 处理：只在目标文件确实少了我们的时候补齐，其它内容原样恢复。
  // ─────────────────────────────────────────────────────────────
  const SELF_PACKAGE = 'dsh-backup-all';

  function readCurrentProfilePackage() {
    try {
      return JSON.parse(readFileSync(join(env.profileDir, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  function selfDependencySpec() {
    const current = readCurrentProfilePackage();
    const dep = current && current.dependencies ? current.dependencies[SELF_PACKAGE] : undefined;
    if (typeof dep === 'string' && dep.trim()) return dep.trim();
    // 兜底：按当前机器插件目录用 link: 指回（安装时会重新链接）
    return 'link:' + env.pluginRoot;
  }

  function preserveSelfInPackageJson(rawText, options = {}) {
    let pkg
    try {
      pkg = JSON.parse(rawText);
    } catch {
      return { text: rawText, changed: false, note: '', warnings: [] };
    }
    const crossOs = options.crossOs === true;
    const warningsOut = [];
    let changed = false;
    const notes = [];
    if (!pkg.dependencies || typeof pkg.dependencies !== 'object') pkg.dependencies = {};

    // 本插件的依赖 spec 一律用当前机器的安装 spec（快照里的 link:/root/... 在目标机上不可用）
    const currentSpec = selfDependencySpec();
    if (currentSpec) {
      if (pkg.dependencies[SELF_PACKAGE] !== currentSpec) {
        pkg.dependencies[SELF_PACKAGE] = currentSpec;
        changed = true;
        notes.push('统一 dependencies.' + SELF_PACKAGE + ' 为当前机器 spec');
      }
    } else if (typeof pkg.dependencies[SELF_PACKAGE] !== 'string' || !pkg.dependencies[SELF_PACKAGE]) {
      pkg.dependencies[SELF_PACKAGE] = currentSpec || '';
      changed = true;
      notes.push('补齐 dependencies.' + SELF_PACKAGE);
    }

    // 跨 OS：其他插件的本地绝对路径依赖（link:/file: 指向旧机绝对路径）在目标机不可用；
    // 保留会导致 pnpm 重建出指向旧路径的 symlink，DSH 重启后插件加载失败。移除并提示重装。
    const removedLocalDeps = [];
    if (crossOs) {
      for (const name of Object.keys(pkg.dependencies)) {
        if (name === SELF_PACKAGE) continue;
        const spec = String(pkg.dependencies[name] || '').trim();
        const m = /^(?:link:|file:)(.*)$/i.exec(spec);
        if (!m) continue;
        const targetPath = String(m[1] || '').trim();
        // 旧机绝对路径（POSIX / 或 Windows 盘符）在目标 OS 上通常不存在；相对路径保留
        if (!/^(?:[A-Za-z]:[\\/]|[\\/])/.test(targetPath)) continue;
        delete pkg.dependencies[name];
        removedLocalDeps.push(name);
        changed = true;
        warningsOut.push('跨 OS：已移除本地插件依赖 ' + name + '（' + spec + ' 在目标机不可用；请重新获取源码并安装）');
      }
    }
    if (removedLocalDeps.length) notes.push('移除跨 OS 不可用依赖 ' + removedLocalDeps.join('、'));

    const profile = pkg.dsh && pkg.dsh.profile ? pkg.dsh.profile : null;
    const keptBundles = [];
    if (profile && Array.isArray(profile.bundles)) {
      for (const b of profile.bundles) {
        if (removedLocalDeps.includes(b)) continue;
        if (b === SELF_PACKAGE) continue;
        keptBundles.push(b);
      }
      keptBundles.push(SELF_PACKAGE);
      if (JSON.stringify(keptBundles) !== JSON.stringify(profile.bundles)) {
        profile.bundles = keptBundles;
        changed = true;
        notes.push('清理 dsh.profile.bundles（本插件置末位）');
      }
    } else if (pkg.dsh && typeof pkg.dsh === 'object') {
      pkg.dsh.profile = { ...(pkg.dsh.profile || {}), bundles: [SELF_PACKAGE] };
      changed = true;
      notes.push('补齐 dsh.profile.bundles');
    }
    if (!changed) return { text: rawText, changed: false, note: '', warnings: [] };
    return {
      text: JSON.stringify(pkg, null, 2) + '\n',
      changed: true,
      note: '恢复时保留本插件：' + notes.join('、'),
      warnings: warningsOut,
    };
  }

  /** 写回前对 profile 配置做「保留本插件」合并；返回 {content, changed, note, warnings} */
  function preserveSelfIfNeeded(target, sourceBytes, options = {}) {
    const base = basename(target);
    const isProfileRootFile = resolve(target) === resolve(join(env.profileDir, base));
    if (!isProfileRootFile) return null;
    if (base === 'package.json' && !/^cordis\.patch/.test(base)) {
      // 只在这是 profile 的 package.json 时处理（上面已限定在 profile 根）
      try {
        const text = sourceBytes.toString('utf8');
        const merged = preserveSelfInPackageJson(text, options);
        return merged;
      } catch {
        return null;
      }
    }
    // cordis.patch.yml 不做文本追加：本插件以 bundle 方式安装时 Loader 行由 bundle patch 提供；
    // 而且 profile 模板常是 `[]`，文本追加会产生非法 YAML / 与 bundle 行重复。
    // package.json 的「依赖 + dsh.profile.bundles」合并已足够保证本插件继续加载。
    return null;
  }

  // 当前恢复是否跨 OS（Linux→Windows 等）；在 applyFiles 内用 compatibility 判定
  let currentCompatibility = null
  function isCrossOsRestore() {
    try {
      if (currentCompatibility) {
        return currentCompatibility.strategy === 'compat-linux-to-windows' || currentCompatibility.strategy === 'compat-windows-to-linux' || currentCompatibility.mode === 'unknown'
      }
      const snap = manifest?.environment || {}
      const snapOs = String(snap.osType || '').toLowerCase()
      const curOs = String(env.osType || detectOsType(process.platform)).toLowerCase()
      return Boolean(snapOs && curOs && snapOs !== curOs)
    } catch {
      return false
    }
  }

  async function applyFiles(wantedPaths) {
    const wanted = Array.isArray(wantedPaths) && wantedPaths.length ? new Set(wantedPaths.map((p) => resolve(String(p)))) : null
    const results = []
    const skipped = []
    const warnings = []
    let applied = 0
    let failed = 0

    // 计算 compatibility 并强制执行 restrictions
    const snapshotEnvironment = manifest?.environment || {}
    const currentEnvironment = {
      osType: env.osType || detectOsType(process.platform),
      platform: process.platform,
      arch: process.arch,
      dshVersion: env.dshVersion || null,
      nodeVersion: process.version,
      dshHome: env.dshHome,
      profileDir: env.profileDir,
      homeDir: env.homeDir,
      workspaces: workspaces,
    }
    const compatibility = buildCompatibility(snapshotEnvironment, currentEnvironment, { crossOsPluginCode })
    currentCompatibility = compatibility

    // blocked：直接返回，不写任何文件
    if (!compatibility.supported && compatibility.strategy === 'blocked') {
      return {
        ok: false,
        applied: 0,
        failed: 0,
        results: [],
        skipped: [],
        warnings: [],
        compatibility,
        error: '该跨 OS 组合不在支持矩阵：不执行任何写回。请手动解包快照、参考 RESTORE.md 与 manifest.json 重建环境。',
      }
    }

    // 预计算 restrictions set
    const restrictions = new Set(compatibility.restrictions || [])

    for (const [index, entry] of entries.entries()) {
      const resolved = resolveEntry(entry)
      const target = resolved.ok ? resolved.target : null

      const isPluginCode = String(entry?.kind).toLowerCase() === 'plugin-code'
      // skip-plugin-code：跳过插件代码条目
      if (restrictions.has('skip-plugin-code') && isPluginCode) {
        skipped.push({
          target: target || entry.target,
          archivePath: entry.archivePath,
          kind: entry.kind,
          reason: 'restriction: skip-plugin-code（跨 OS 兼容策略：插件代码不写回）',
        })
        warnings.push('skip-plugin-code：跳过插件代码条目 ' + (entry.archivePath || entry.target))
        continue
      }
      // plugin-code-js-only：用户启用了「迁移纯 JS 插件代码」，Host 逐个校验
      if (restrictions.has('plugin-code-js-only') && isPluginCode) {
        const srcDir = join(extractedDir, String(entry.archivePath || ''))
        const sst = statSafe(srcDir)
        const verdict = sst && sst.isDirectory()
          ? classifyPluginCodeDir(srcDir, { osType: env.osType, arch: env.arch })
          : { pure: false, reason: '快照内插件代码目录缺失或不是目录' }
        if (!verdict.pure) {
          skipped.push({
            target: target || entry.target,
            archivePath: entry.archivePath,
            kind: entry.kind,
            reason: 'restriction: plugin-code-js-only（未通过纯 JS 校验：' + verdict.reason + '）',
          })
          warnings.push('plugin-code-js-only：跳过插件代码 ' + (entry.archivePath || entry.target) + '（' + verdict.reason + '）')
          continue
        }
        log('跨 OS 纯 JS 插件代码迁移：' + (entry.archivePath || entry.target) + '（' + verdict.reason + '）')
      }

      if (wanted && (!target || !wanted.has(resolve(target)))) continue
      if (!target) {
        results.push({ target: entry.target, ok: false, error: resolved.reason || '目标路径无法解析或不安全（$WORKSPACE 未匹配 / 不在允许范围）' })
        failed++
        continue
      }
      const remap = resolved.remapped
        ? { original: resolved.original, reason: resolved.reason, mode: resolved.mode }
        : null
      let src = join(extractedDir, entry.archivePath)
      let st = statSafe(src)
      // 符号链接/单文件的情况：archivePath 可能是个文件
      if (!st) {
        results.push({ target, ok: false, error: '快照内文件缺失：' + entry.archivePath })
        failed++
        continue
      }
      try {
        const safety = await backupExisting(target, index)
        mkdirSync(dirname(target), { recursive: true })
        let preservedSelf = null
        if (st.isDirectory()) {
          mkdirSync(target, { recursive: true })
          await fsp.cp(src, target, { recursive: true, force: true })
        } else {
          // profile 的 package.json / cordis.patch.yml：写回前做「保留本插件」合并
          let written = false
          try {
            const merged = preserveSelfIfNeeded(target, readFileSync(src), { crossOs: isCrossOsRestore() })
            if (merged) {
              const destFile = (() => {
                const tst = statSafe(target)
                return tst && tst.isDirectory() ? join(target, basename(src)) : target
              })()
              await fsp.writeFile(destFile, merged.text, 'utf8')
              written = true
              if (merged.changed) {
                preservedSelf = merged.note
                log(merged.note)
              }
              if (Array.isArray(merged.warnings) && merged.warnings.length) {
                for (const w of merged.warnings) {
                  warnings.push(w)
                  log(w)
                }
              }
            }
          } catch {}
          if (!written) {
            // 目标是已存在的目录时把文件放进去
            const tst = statSafe(target)
            if (tst && tst.isDirectory()) await fsp.copyFile(src, join(target, basename(src)))
            else await fsp.copyFile(src, target)
          }
        }
        applied++
        results.push({ target, ok: true, safetyBackup: safety, remap, preservedSelf })
      } catch (error) {
        failed++
        results.push({ target, ok: false, error: String((error && error.message) || error), remap })
      }
    }
    return { ok: failed === 0, applied, failed, results: results.slice(0, 100), truncated: results.length > 100, skipped: skipped.slice(0, 100), warnings: warnings.slice(0, 100), compatibility }
  }

  const tools = [
    {
      name: 'restore_inspect_archive',
      description:
        '读取快照包内容：summary（摘要）/ manifest（机器清单）/ plan（恢复计划）/ doc（RESTORE.md 正文）/ entries（文件条目）/ all。先看 doc 和 summary，再决定恢复策略。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section: { type: 'string', enum: ['summary', 'manifest', 'plan', 'doc', 'entries', 'all'], description: '默认 summary' },
          offset: { type: 'number', description: 'entries 分页偏移，默认 0' },
          limit: { type: 'number', description: 'entries 每页条数，默认 80，最大 200' },
        },
      },
      async execute(args = {}) {
        const section = String(args.section || 'summary')
        if (section === 'doc') return jsonOut({ ok: true, doc: String(restoreDoc || '').slice(0, MAX_TEXT_CHARS), truncated: String(restoreDoc || '').length > MAX_TEXT_CHARS })
        if (section === 'manifest') return jsonOut({ ok: true, manifest })
        if (section === 'plan') return jsonOut({ ok: true, plan })
        if (section === 'entries') {
          const offset = clampInt(args.offset, 0, 100000, 0)
          const limit = clampInt(args.limit, 1, 200, 80)
          return jsonOut({ ok: true, total: entries.length, offset, limit, items: entries.slice(offset, offset + limit), hasMore: offset + limit < entries.length })
        }
        const summary = {
          snapshot: manifest?.snapshot || {},
          createdAt: manifest?.createdAt || '',
          environment: manifest?.environment || {},
          counts: {
            entries: entries.length,
            configFiles: (manifest?.configFiles || []).length,
            plugins: (manifest?.plugins || []).length,
            skills: (manifest?.skills || []).length,
            mcpRows: (manifest?.mcpRows || []).length,
            presetRows: (manifest?.presetRows || []).length,
            warnings: (manifest?.warnings || []).length,
          },
          docChars: String(restoreDoc || '').length,
          planSteps: Array.isArray(plan?.steps) ? plan.steps.length : 0,
        }
        if (section === 'all') return jsonOut({ ok: true, summary, manifest, plan, doc: String(restoreDoc || '').slice(0, MAX_TEXT_CHARS) })
        return jsonOut({ ok: true, summary })
      },
      summarize: () => '读取快照内容',
    },
    {
      name: 'restore_compare',
      description: '对比快照与当前环境：每个条目是缺失(missing)/一致(same)/不同(different)/无法映射(unmapped)，并列出插件安装情况。恢复前必须调用一次，据此决定恢复范围。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      async execute() {
        const result = compare()
        log(
          '环境比对完成：缺失 ' + (result.summary.missing || 0) +
          '，不同 ' + (result.summary.different || 0) +
          '，一致 ' + (result.summary.same || 0) +
          '，无法映射 ' + (result.summary.unmapped || 0),
        )
        return jsonOut(result)
      },
      summarize: (v) => {
        try {
          const j = JSON.parse(v)
          return '比对：缺失 ' + (j.summary.missing || 0) + ' / 不同 ' + (j.summary.different || 0)
        } catch {
          return '比对完成'
        }
      },
    },
    {
      name: 'restore_set_progress',
      description: '刷新界面进度条。恢复阶段请使用 45~98 之间：从 45 开始，finish 前不超过 98（Host 会在最后收尾到 100）。必须周期性调用（每阶段/每 30~60 秒）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          progress: { type: 'number' },
          phase: { type: 'string' },
          message: { type: 'string' },
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
      name: 'restore_log',
      description: '往界面输出窗口写一条日志。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      async execute(args = {}) {
        log('AI：' + String(args.message || '').slice(0, 500))
        return '已记录'
      },
      summarize: () => '记录日志',
    },
    {
      name: 'restore_apply_files',
      description:
        '按 manifest.entries 把快照里的文件写回目标路径（Host 会自动做跨机器路径重映射：占位符→旧根前缀→workspace basename→fallback 目录，结果里会返回 remap 字段）。旧文件会先自动备份到安全目录。paths 为空/缺省表示恢复全部条目；也可以传目标绝对路径列表只恢复一部分。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '可选：只恢复这些目标绝对路径' },
        },
      },
      async execute(args = {}) {
        const wanted = Array.isArray(args.paths) ? args.paths : []
        const result = await applyFiles(wanted)
        log('恢复文件：成功 ' + result.applied + ' 项' + (result.failed ? '，失败 ' + result.failed + ' 项' : ''))
        if (result.failed) {
          setProgress({ phase: '部分恢复失败', message: '有 ' + result.failed + ' 个条目恢复失败，请查看输出窗口' })
        }
        return jsonOut(result)
      },
      summarize: (v) => {
        try {
          const j = JSON.parse(v)
          return '写回文件：成功 ' + (j.applied || 0) + (j.failed ? '，失败 ' + j.failed : '')
        } catch {
          return '写回文件'
        }
      },
    },
    {
      name: 'restore_reinstall_dependencies',
      description:
        '重新安装 profile 依赖（插件代码本体不在快照里，恢复配置后通常需要重装/重新链接）。只在确实需要时调用一次；可能耗时数分钟且需要网络。命令：dsh plugin --profile <name> install（失败则尝试 pnpm install）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timeoutMs: { type: 'number', description: '超时毫秒，默认 300000，最大 900000' },
        },
      },
      async execute(args = {}) {
        const timeoutMs = clampInt(args.timeoutMs, 30_000, 900_000, 300_000)
        const result = await deps.reinstallDependencies(timeoutMs)
        if (result.ok) log('依赖安装完成（' + result.command + '）')
        else log('依赖安装失败：' + (result.error || ('exit ' + result.exitCode)))
        return jsonOut(result)
      },
      summarize: (v) => {
        try {
          const j = JSON.parse(v)
          return j.ok ? '依赖安装完成' : '依赖安装失败'
        } catch {
          return '依赖安装'
        }
      },
    },
    {
      name: 'restore_finish',
      description:
        '【最后一步】结束恢复：写入恢复摘要并通知 Host 完成。摘要要包含：恢复了哪些内容、是否有失败项、是否重新安装了依赖、是否必须重启 DSH、需要用户人工确认的事项。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { summary: { type: 'string', description: '中文恢复摘要（给用户看）' } },
        required: ['summary'],
      },
      async execute(args = {}) {
        const summary = String(args.summary || '').slice(0, 4000)
        setProgress({ progress: 99, phase: '完成恢复', message: '恢复完成，等待重启 DSH 生效' })
        setFinished(summary)
        return jsonOut({ ok: true, finished: true })
      },
      summarize: () => '完成恢复',
    },
  ]

  return { tools, compare, applyFiles }
}
