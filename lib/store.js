// dsh-backup-all · 插件自己的数据文件
//
// data/records.json  快照记录（名字 ↔ 压缩包文件）
// data/settings.json AI 配置（含 API Key，文件权限 0600）
//
// 纪律：
//  - 所有写入走「临时文件 + rename」原子替换，避免 DSH 崩溃留下半个 JSON。
//  - 读坏了不炸整插件：返回默认值并保留坏文件副本（.broken-<ts>）。
//  - 记录里指向的压缩包若已不存在，读取时剔除（记录是派生数据，包才是本体）。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, copyFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
}

/**
 * 原子写（mode 可指定，默认 0o644；settings 用 0o600）。
 * 先以目标权限创建文件再写内容，避免「已写入明文 Key 但权限还没收紧」的窗口；
 * 临时文件名带随机后缀，且同目录 rename 保证原子替换。
 */
export function writeJsonAtomic(file, value, mode = 0o644) {
  ensureDir(dirname(file))
  const tmp = file + '.tmp-' + randomBytes(6).toString('hex')
  let fd = null
  try {
    fd = openSync(tmp, 'wx', mode)
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' })
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
  try {
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw error
  }
}

function readJsonSafe(file, fallback, label) {
  try {
    if (!existsSync(file)) return fallback
    const text = readFileSync(file, 'utf8')
    if (!text.trim()) return fallback
    return JSON.parse(text)
  } catch (error) {
    // 坏文件保留副本，避免用户数据被下一次写覆盖后无从追查
    try {
      const broken = file + '.broken-' + Date.now()
      copyFileSync(file, broken)
    } catch {}
    return fallback
  }
}

export const DEFAULT_AI = {
  baseURL: '',
  protocol: 'openai-completions', // openai-completions | anthropic-messages
  apiKey: '',
  modelId: '',
  contextWindow: 256000,
  maxOutput: 32768,
  effort: 'max', // off | low | high | max
  connected: null, // null 未测 | true | false
  connectedAt: '',
  connectDetail: '',
}

export const DEFAULT_SNAPSHOT_POLICY = {
  // 插件代码本体打包策略：local-only（不可再下载的本地插件必须入包）| all | none
  packPluginCode: 'local-only',
  // 是否不打包凭据文件（true = 不打包，恢复后需重新填 Key）
  excludeCredentials: false,
  // 跨 OS 恢复时插件代码策略：skip（默认，跳过）| js（尝试迁移纯 JS 插件代码，实验性增强）
  crossOsPluginCode: 'skip',
}

export const DEFAULT_SETTINGS = {
  version: 1,
  ai: { ...DEFAULT_AI },
  snapshot: { ...DEFAULT_SNAPSHOT_POLICY },
}

/** 快照策略的对外视图（无需掩码，直接返回） */
export function publicSnapshotSettings(snapshot) {
  const cur = { ...DEFAULT_SNAPSHOT_POLICY, ...(snapshot || {}) }
  return {
    packPluginCode: ['local-only', 'all', 'none'].includes(cur.packPluginCode) ? cur.packPluginCode : 'local-only',
    excludeCredentials: cur.excludeCredentials === true,
    crossOsPluginCode: ['skip', 'js'].includes(cur.crossOsPluginCode) ? cur.crossOsPluginCode : 'skip',
  }
}

export function maskApiKey(key) {
  const s = String(key || '')
  if (!s) return ''
  if (s.length <= 8) return '****'
  return s.slice(0, 3) + '…' + s.slice(-4)
}

/** AI 配置是否齐全（三项必填；contextWindow/maxOutput 有默认值） */
export function isAiConfigured(ai) {
  return Boolean(ai && String(ai.baseURL || '').trim() && String(ai.modelId || '').trim() && String(ai.apiKey || '').trim())
}

/** 对外的 AI 配置视图（绝不下发 apiKey 明文，只给掩码与 hasApiKey） */
export function publicAiSettings(ai) {
  const cur = { ...DEFAULT_AI, ...(ai || {}) }
  return {
    baseURL: cur.baseURL || '',
    protocol: cur.protocol || 'openai-completions',
    modelId: cur.modelId || '',
    contextWindow: Number(cur.contextWindow) || DEFAULT_AI.contextWindow,
    maxOutput: Number(cur.maxOutput) || DEFAULT_AI.maxOutput,
    effort: cur.effort || 'max',
    hasApiKey: Boolean(cur.apiKey),
    apiKeyMasked: maskApiKey(cur.apiKey),
    configured: isAiConfigured(cur),
    connected: cur.connected === true ? true : cur.connected === false ? false : null,
    connectedAt: cur.connectedAt || '',
    connectDetail: cur.connectDetail || '',
  }
}

export function createStore(env) {
  const recordsFile = env.recordsFile
  const settingsFile = env.settingsFile

  function readSettings() {
    const raw = readJsonSafe(settingsFile, null, 'settings')
    const ai = { ...DEFAULT_AI, ...((raw && raw.ai) || {}) }
    const snapshot = { ...DEFAULT_SNAPSHOT_POLICY, ...((raw && raw.snapshot) || {}) }
    return { version: 1, ai, snapshot: publicSnapshotSettings(snapshot) }
  }

  function writeSettings(settings) {
    // 防御：只写我们认识的字段，apiKey 保持原样（调用方负责合并）
    const normalized = {
      version: 1,
      ai: { ...DEFAULT_AI, ...(settings && settings.ai ? settings.ai : {}) },
      snapshot: { ...DEFAULT_SNAPSHOT_POLICY, ...(settings && settings.snapshot ? settings.snapshot : {}) },
    }
    writeJsonAtomic(settingsFile, normalized, 0o600)
    return normalized
  }

  function readRecords() {
    const raw = readJsonSafe(recordsFile, null, 'records')
    const list = raw && Array.isArray(raw.records) ? raw.records : []
    const records = []
    for (const r of list) {
      if (!r || typeof r !== 'object') continue
      if (!r.id || !r.file) continue
      records.push({
        id: String(r.id),
        name: String(r.name || ''),
        description: String(r.description || ''),
        createdAt: String(r.createdAt || new Date().toISOString()),
        file: String(r.file),
        bytes: Number(r.bytes) || 0,
        archived: Boolean(r.archived),
        kind: r.kind === 'pre-restore' ? 'pre-restore' : 'snapshot',
        snapshotId: r.snapshotId ? String(r.snapshotId) : '',
        osType: r.osType && ['linux', 'windows', 'other', 'unknown'].includes(String(r.osType)) ? String(r.osType) : 'unknown',
        imported: r.imported === true,
      })
    }
    // 记录是派生数据：压缩包不存在就没必要展示
    return records.filter((r) => {
      try {
        return existsSync(env.backupDir + '/' + r.file)
      } catch {
        return false
      }
    })
  }

  function writeRecords(records) {
    const normalized = (records || []).map((r) => ({
      id: String(r.id),
      name: String(r.name || ''),
      description: String(r.description || ''),
      createdAt: String(r.createdAt || new Date().toISOString()),
      file: String(r.file),
      bytes: Number(r.bytes) || 0,
      archived: Boolean(r.archived),
      kind: r.kind === 'pre-restore' ? 'pre-restore' : 'snapshot',
      snapshotId: r.snapshotId ? String(r.snapshotId) : '',
      osType: r.osType && ['linux', 'windows', 'other', 'unknown'].includes(String(r.osType)) ? String(r.osType) : 'unknown',
      imported: r.imported === true,
    }))
    writeJsonAtomic(recordsFile, { version: 1, records: normalized }, 0o644)
    return normalized
  }

  /** 列表：恢复前快照固定第一，其余按创建时间倒序；归档的排最后（由 UI 过滤）。 */
  function listRecords() {
    const records = readRecords()
    const sorted = records.slice().sort((a, b) => {
      const pa = a.kind === 'pre-restore' ? 0 : 1
      const pb = b.kind === 'pre-restore' ? 0 : 1
      if (pa !== pb) return pa - pb
      return String(b.createdAt).localeCompare(String(a.createdAt))
    })
    return sorted
  }

  function totalBytes() {
    let total = 0
    try {
      for (const r of readRecords()) total += Number(r.bytes) || 0
    } catch {}
    return total
  }

  function deleteArchiveFile(record) {
    try {
      const p = env.backupDir + '/' + record.file
      if (existsSync(p)) unlinkSync(p)
      return true
    } catch {
      return false
    }
  }

  return {
    env,
    readSettings,
    writeSettings,
    readRecords,
    writeRecords,
    listRecords,
    totalBytes,
    deleteArchiveFile,
  }
}
