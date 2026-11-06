// Host 端到端联调测试（无第三方依赖）：
//   - 起一个本地 OpenAI 兼容 mock 服务，按脚本返回 tool_calls（快照脚本 / 恢复脚本）
//   - 用假 ctx 构造 createBackupRuntime，数据目录指向 os.tmpdir()
//   - 走真实快照 → 校验压缩包/manifest/RESTORE.md/records.json
//   - 走真实恢复（含自动「恢复前快照」）→ 校验写回与记录顺序
//   - 走中断 → 校验 interrupted + 清理缓存 + 不产生记录
//
// 注意：inventory 扫描读取真实 DSH_HOME（只读），所以测试会在当前机器上取真实环境清单；
// 但所有写入都落在临时目录，不会碰真实 profile/backup。

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createBackupRuntime } from '../lib/runner.js'
import { listArchive, extractArchive } from '../lib/archive.js'
import { resolveEnv } from '../lib/paths.js'

const snapshotScript = [
  { tool: 'backup_set_progress', args: { progress: 5, phase: '启动' } },
  { tool: 'backup_get_inventory', args: { section: 'summary' } },
  { tool: 'backup_set_progress', args: { progress: 40, phase: '找外部文件' } },
  { tool: 'backup_set_restore_plan', args: { plan: { steps: [{ id: 'files', title: '放回文件' }, { id: 'restart', title: '重启 DSH' }] } } },
  { tool: 'backup_write_restore_doc', args: { markdown: '# 恢复说明（测试）\n\n1. 放回文件\n2. 重启 DSH' } },
  { tool: 'backup_build', args: { summary: 'e2e 测试快照' } },
  { text: '快照完成' },
]
const restoreScript = [
  { tool: 'restore_inspect_archive', args: { section: 'summary' } },
  { tool: 'restore_compare', args: {} },
  { tool: 'restore_apply_files', args: {} },
  { tool: 'restore_finish', args: { summary: 'e2e 恢复完成：需重启 DSH' } },
  { text: '恢复完成' },
]

let server
let port
let runtime
let baseDir
let reinstallCalls = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sse(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n')
}

function emitToolCall(res, call) {
  sse(res, { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + Math.random().toString(36).slice(2), type: 'function', function: { name: call.tool, arguments: '' } }] }, finish_reason: null }] })
  const text = JSON.stringify(call.args || {})
  sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: text } }] }, finish_reason: null }] })
  sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

function emitText(res, text) {
  sse(res, { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
  sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  res.write('data: [DONE]\n\n')
  res.end()
}

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[{"id":"mock-model"}]}')
      return
    }
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {}
      const messages = payload.messages || []
      const system = String((messages.find((m) => m.role === 'system') || {}).content || '')
      const assistantCount = messages.filter((m) => m.role === 'assistant').length
      const isRestore = system.startsWith('# DSH 环境恢复 AI')
      const script = isRestore ? restoreScript : snapshotScript
      const step = script[Math.min(assistantCount, script.length - 1)]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (step && step.tool) emitToolCall(res, step)
      else emitText(res, (step && step.text) || '完成')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port

  baseDir = join(tmpdir(), 'dsh-backup-all-e2e-' + process.pid + '-' + Date.now())
  mkdirSync(baseDir, { recursive: true })
  // 造一个 fixture DSH 环境：所有写入都在临时目录，不碰真实 profile
  const dshHome = join(baseDir, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'web')
  const externalPlugin = join(dshHome, 'dshbox', 'dshbox-plugins', 'fake-local', 'plugin')
  mkdirSync(join(profileDir, 'node_modules', '@local', 'fake-a'), { recursive: true })
  mkdirSync(externalPlugin, { recursive: true })
  mkdirSync(join(dshHome, 'skills', 'demo-skill'), { recursive: true })
  mkdirSync(join(dshHome, 'xingxi', '会话'), { recursive: true })
  mkdirSync(join(dshHome, 'dshbox'), { recursive: true })
  writeFileSync(join(dshHome, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: fixture skill\n---\n\n# Demo\n', 'utf8')
  writeFileSync(join(dshHome, 'xingxi', 'config.json'), '{"fixture":true}\n', 'utf8')
  writeFileSync(join(dshHome, '.credentials.yaml'), 'version: 1\nrecords:\n  fixture:\n    kind: grant\n', 'utf8')
  writeFileSync(join(dshHome, 'dshbox', 'plugin-guard.json'), '{"safetyMode":true}\n', 'utf8')
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-fixture',
      private: true,
      dependencies: { '@local/fake-a': 'file:./fake-a-src' },
      dsh: { profile: { bundles: ['@local/fake-a'] } },
    }, null, 2),
    'utf8',
  )
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: fake-a\n  name: "@local/fake-a"\n', 'utf8')
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8')
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
  writeFileSync(
    join(profileDir, 'node_modules', '@local', 'fake-a', 'package.json'),
    JSON.stringify({ name: '@local/fake-a', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2),
    'utf8',
  )
  writeFileSync(
    join(profileDir, 'node_modules', '@local', 'fake-a', 'cordis.patch.yml'),
    '- insert:\n    - id: fake-mcp\n      name: "@deepseek-ai/dsh-mcp-client"\n      config:\n        serverName: demo\n        transport: stdio\n        command: node\n    - id: preset-fake\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: fake\n        plugins: []\n',
    'utf8',
  )
  writeFileSync(join(profileDir, 'node_modules', '@local', 'fake-a', 'index.js'), 'export function apply() {}\n', 'utf8')
  writeFileSync(join(externalPlugin, 'package.json'), JSON.stringify({ name: '@local/fake-local', version: '1.0.0' }), 'utf8')

  reinstallCalls = []
  runtime = createBackupRuntime(
    { get: () => undefined, logger: () => ({ info() {}, error() {} }) },
    {
      paths: { dshHome, profileName: 'web', profileDir, homeDir: join(baseDir, 'home'), backupDir: join(baseDir, 'backup'), dataDir: join(baseDir, 'data') },
      testHooks: {
        reinstallDependencies: async () => {
          reinstallCalls.push(Date.now())
          return { ok: true, command: 'fake dsh plugin install', exitCode: 0, outputTail: 'fake' }
        },
      },
    },
  )
  runtime.saveSettings({
    baseURL: 'http://127.0.0.1:' + port + '/v1',
    protocol: 'openai-completions',
    apiKey: 'test-key',
    modelId: 'mock-model',
    contextWindowValue: 1000,
    contextWindowUnit: 'K',
    maxOutputValue: 32,
    maxOutputUnit: 'K',
    effort: 'max',
  })
})

after(async () => {
  try {
    runtime && runtime.dispose()
  } catch {}
  try {
    server && server.close()
  } catch {}
  try {
    rmSync(baseDir, { recursive: true, force: true })
  } catch {}
})

async function waitRun(label, timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = runtime.getState()
    if (state.run && state.run.status !== 'running') return state
    await sleep(150)
  }
  throw new Error('run timeout: ' + label)
}

test('快照：mock AI 驱动完整流程，产出 .backup.tar.br + manifest + RESTORE.md + 记录', async () => {
  const env = runtime.env
  assert.ok(env.backupDir.startsWith(baseDir))
  const started = runtime.startSnapshot({ name: 'e2e 快照', description: '端到端测试' })
  assert.equal(started.ok, true, started.error)
  const state = await waitRun('snapshot')
  assert.equal(state.run.status, 'done', state.run.error || '')
  assert.equal(state.records.length, 1)
  const record = state.records[0]
  assert.equal(record.name, 'e2e 快照')
  assert.match(record.file, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}-(linux|windows|other)\.backup\.tar\.br$/)
  assert.ok(record.bytes > 0)
  assert.equal(state.totalBytes, record.bytes)

  const file = join(env.backupDir, record.file)
  assert.ok(existsSync(file), 'archive exists')
  const listed = await listArchive({ archiveFile: file, maxEntries: 200 })
  const names = listed.entries.map((entry) => entry.path)
  assert.ok(names.includes('manifest.json'))
  assert.ok(names.includes('RESTORE.md'))
  assert.ok(names.includes('restore-plan.json'))

  const extractDir = join(baseDir, 'extract')
  await extractArchive({ archiveFile: file, destDir: extractDir })
  const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.snapshot.name, 'e2e 快照')
  assert.ok(Array.isArray(manifest.entries) && manifest.entries.length > 0)
  assert.equal(manifest.credentialsIncluded, true)
  // 新策略：不可再下载的本地插件（fixture 里 @local/fake-a 是 file: 依赖）代码本体必须入包
  const codeEntries = manifest.entries.filter((entry) => entry.kind === 'plugin-code')
  assert.ok(codeEntries.length >= 1, 'local non-redownloadable plugin code must be packed')
  const fakePlugin = (manifest.plugins || []).find((plugin) => plugin.name === '@local/fake-a')
  assert.ok(fakePlugin, 'plugin metadata present')
  assert.equal(fakePlugin.redownloadable, false)
  assert.equal(fakePlugin.packed, true)
  assert.ok(codeEntries.some((entry) => String(entry.source).includes('fake-a')), 'fake-a code packed')
  // 可再下载插件（若有）默认只记元数据 —— fixture 中没有 registry 插件，校验策略字段即可
  assert.equal(manifest.snapshotPolicy.packPluginCode, 'local-only')
  // 凭据文件必须入包（用户选择）
  const credentialsPacked = manifest.entries.some((entry) => String(entry.source).endsWith('.credentials.yaml'))
  assert.equal(credentialsPacked, existsSync(join(env.dshHome, '.credentials.yaml')))
  // RESTORE.md 必须是 AI 正文 + Host 拼装的完整文档
  const doc = readFileSync(join(extractDir, 'RESTORE.md'), 'utf8')
  assert.ok(doc.includes('恢复说明（测试）'))
  assert.ok(doc.includes('重启 DSH'))
  // 记录文件与压缩包一一对应
  const recordsFile = JSON.parse(readFileSync(join(env.dataDir, 'records.json'), 'utf8'))
  assert.equal(recordsFile.records.length, 1)
  assert.equal(recordsFile.records[0].file, record.file)
})

test('恢复：自动创建唯一的「恢复前快照」并固定排第一位', async () => {
  const before = runtime.getState()
  const target = before.records[0]
  const started = runtime.startRestore({ id: target.id })
  assert.equal(started.ok, true, started.error)
  const state = await waitRun('restore')
  assert.equal(state.run.status, 'done', state.run.error || '')
  assert.ok(state.run.summary.includes('恢复完成') || state.run.summary.includes('重启'))
  const preRecords = state.records.filter((record) => record.kind === 'pre-restore')
  assert.equal(preRecords.length, 1, '只允许一个恢复前快照')
  assert.equal(state.records[0].id, preRecords[0].id, '恢复前快照排第一')
  assert.equal(preRecords[0].name, '恢复前快照')
  // 用户要求：恢复末尾由 Host 机械性强制安装一次依赖
  assert.ok(reinstallCalls.length >= 1, 'Host must force one dependency install after restore')
  assert.match(state.run.summary, /依赖安装/)
})

test('中断：run 变 interrupted，缓存清理，不产生新记录', async () => {
  // 用一个永不回包的 AI 端点模拟卡住
  const slow = http.createServer((req, res) => {
    if (req.method === 'GET' && String(req.url).endsWith('/models')) {
      res.writeHead(200)
      res.end('{"data":[]}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': waiting\n\n')
    const timer = setTimeout(() => res.end(), 20000)
    req.on('close', () => clearTimeout(timer))
  })
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve))
  const slowPort = slow.address().port
  runtime.saveSettings({ baseURL: 'http://127.0.0.1:' + slowPort + '/v1', protocol: 'openai-completions', modelId: 'slow-model' })
  const countBefore = runtime.getState().records.length
  const started = runtime.startSnapshot({ name: '中断测试', description: '' })
  assert.equal(started.ok, true, started.error)
  await sleep(800)
  const abortResult = runtime.abortRun({ runId: started.runId })
  assert.equal(abortResult.ok, true)
  const state = await waitRun('abort', 20000)
  assert.equal(state.run.status, 'interrupted')
  assert.equal(runtime.getState().records.length, countBefore, '中断不应留下记录')
  // 缓存目录被清理
  const cacheDir = join(baseDir, 'backup', '.cache')
  const leftovers = existsSync(cacheDir) ? readdirSync(cacheDir) : []
  assert.deepEqual(leftovers, [], '中断后不应残留 run 缓存')
  await new Promise((resolve) => slow.close(resolve))
})

test('记录 CRUD / 设置与离线兜底', async () => {
  const env = resolveEnv()
  // 设置：空 apiKey 不覆盖已存值
  const before = runtime.getAiSettings()
  const saved = runtime.saveSettings({ apiKey: '' })
  assert.equal(saved.settings.ai.hasApiKey, before.apiKey ? true : saved.settings.ai.hasApiKey)
  // 清空所有快照
  const cleared = runtime.clearAll({ confirm: true })
  assert.equal(cleared.ok, true)
  const state = runtime.getState()
  assert.equal(state.records.length, 0)
  assert.equal(state.archived.length, 0)
  assert.equal(state.totalBytes, 0)
  // 无 AI 配置时创建应被拒绝
  runtime.saveSettings({ apiKey: null })
  const denied = runtime.startSnapshot({ name: 'x' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /AI/)
  // 恢复不存在的记录
  const missing = runtime.startRestore({ id: 'nope' })
  assert.equal(missing.ok, false)
  assert.ok(env.profileName)
})

test('策略：不打包凭据 + 不打包插件代码（manifest/RESTORE.md 如实反映）', async () => {
  // 用当前 mock 服务重新配好 AI
  runtime.saveSettings({
    baseURL: 'http://127.0.0.1:' + port + '/v1',
    protocol: 'openai-completions',
    apiKey: 'test-key',
    modelId: 'mock-model',
    contextWindowValue: 1000,
    contextWindowUnit: 'K',
    maxOutputValue: 32,
    maxOutputUnit: 'K',
    effort: 'max',
    snapshot: { packPluginCode: 'none', excludeCredentials: true },
  })
  const saved = runtime.getSnapshotSettings()
  assert.deepEqual(saved, { packPluginCode: 'none', excludeCredentials: true, crossOsPluginCode: 'skip' })

  const started = runtime.startSnapshot({ name: '策略快照', description: '不打包凭据与插件代码' })
  assert.equal(started.ok, true, started.error)
  const state = await waitRun('policy-snapshot')
  assert.equal(state.run.status, 'done', state.run.error || '')
  const record = state.records.find((item) => item.name === '策略快照')
  assert.ok(record, 'policy snapshot record exists')

  const extractDir = join(baseDir, 'extract-policy')
  await extractArchive({ archiveFile: join(runtime.env.backupDir, record.file), destDir: extractDir })
  const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf8'))
  assert.equal(manifest.credentialsIncluded, false, 'credentials must not be packed when excludeCredentials=true')
  assert.equal(manifest.entries.some((entry) => entry.kind === 'credentials'), false, 'no credentials entry')
  assert.ok(
    (manifest.excluded || []).some((item) => String(item.path).includes('.credentials.yaml')),
    'excluded should mention credentials',
  )
  assert.equal(manifest.entries.some((entry) => entry.kind === 'plugin-code'), false, 'no plugin code packed under none')
  assert.equal(manifest.snapshotPolicy.packPluginCode, 'none')
  const fakePlugin = (manifest.plugins || []).find((plugin) => plugin.name === '@local/fake-a')
  assert.equal(fakePlugin.packed, false, 'local plugin not packed under none')
  assert.equal(fakePlugin.redownloadable, false)
  assert.ok((manifest.notPacked || []).some((item) => String(item.path).includes('fake-a')), 'notPacked lists local plugin')
  const doc = readFileSync(join(extractDir, 'RESTORE.md'), 'utf8')
  assert.ok(doc.includes('未包含') || doc.includes('不打包凭据'), 'RESTORE.md must state credentials are not packed')
  assert.ok(doc.includes('插件代码本体策略') || doc.includes('packPluginCode'), 'RESTORE.md must state plugin-code policy')
})

test('主 Agent 工具：注册描述含使用限制，create 可启动、restore 必须 confirm', async () => {
  const { createAgentToolDefinitions } = await import('../lib/agent-tools.js')
  const definitions = createAgentToolDefinitions(runtime)
  assert.equal(definitions.length, 2)
  const names = definitions.map((definition) => definition.name).sort()
  assert.deepEqual(names, ['backup_all_create_snapshot', 'backup_all_restore_snapshot'])
  for (const definition of definitions) {
    assert.match(definition.description || '', /明确/)
    assert.match(definition.description || '', /不得|不可以/)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.execute, 'function')
  }
  const createTool = definitions.find((definition) => definition.name === 'backup_all_create_snapshot')
  const restoreTool = definitions.find((definition) => definition.name === 'backup_all_restore_snapshot')

  // restore：不传 confirm 必须拒绝
  const denied = await restoreTool.execute({ id: 'whatever' })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /confirm/)
  // restore：不存在的 id 拒绝
  const missing = await restoreTool.execute({ confirm: true, id: 'no-such-record' })
  assert.equal(missing.ok, false)

  // create：后台启动成功（然后立即中断，避免影响后续）
  const created = await createTool.execute({ name: '主 Agent 工具测试' })
  assert.equal(created.ok, true, created.error || '')
  assert.ok(created.runId)
  await sleep(300)
  runtime.abortRun({ runId: created.runId })
  await waitRun('agent-tool-create', 20000)
  assert.ok(['interrupted', 'done'].includes(runtime.getState().run.status), 'run should settle')
})
