// 安全回归测试（对应 docs/AUDIT-HOST.md 的 P0/P1 修复）：
//   P0-1 恢复目标白名单：AI 注入的 target 一律退回自动编码，不能写任意系统路径
//   P0-2 读取守卫：符号链接不能绕过 deny 规则（file: 本地插件的 node_modules 符号链接场景）
//   P0-3 路由 fail-closed：connection 服务缺失时拒绝所有请求
//   P1-1 abort 必须带匹配 runId
//   restore 双层校验：manifest 被篡改也不能写到条目原始 source 之外的位置

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { sanitizeRestoreTarget } from '../lib/collect.js'
import { makeReadGuard } from '../lib/tools-snapshot.js'
import { createRestoreTools } from '../lib/tools-restore.js'
import { resolveEnv } from '../lib/paths.js'
import { registerRoutes } from '../lib/routes.js'

function fixtureEnv() {
  const base = join(tmpdir(), 'dsh-ba-sec-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  const dshHome = join(base, 'home')
  const profileDir = join(dshHome, 'profiles', 'web')
  const workspace = join(base, 'ws')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(dshHome, 'sessions'), { recursive: true })
  mkdirSync(join(dshHome, 'storages'), { recursive: true })
  writeFileSync(join(dshHome, 'cordis.patch.yml'), '- id: x\n', 'utf8')
  writeFileSync(join(dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  KEY: secret\n', 'utf8')
  writeFileSync(join(workspace, 'project.txt'), 'hello\n', 'utf8')
  const env = resolveEnv({ dshHome, profileName: 'web', profileDir, homeDir: base, backupDir: join(base, 'backup'), dataDir: join(base, 'data') })
  return { base, env, workspace, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('P0-1 sanitizeRestoreTarget：AI 注入的任意 target 退回自动编码，安全 target 保留', () => {
  const { env, workspace, cleanup } = fixtureEnv()
  try {
    const workspaces = [{ id: 'w', name: 'proj', path: workspace }]
    const source = join(env.dshHome, 'xingxi', 'config.json')
    // 恶意 target → 退回到 source 的自动编码
    assert.equal(sanitizeRestoreTarget('/etc/cron.d/evil', source, env, workspaces), '$DSH_HOME/xingxi/config.json')
    assert.equal(sanitizeRestoreTarget('/root/.ssh/authorized_keys', source, env, workspaces), '$DSH_HOME/xingxi/config.json')
    assert.equal(sanitizeRestoreTarget('../../outside', source, env, workspaces), '$DSH_HOME/xingxi/config.json')
    // 合法编码串保留
    assert.equal(sanitizeRestoreTarget('$DSH_PROFILE_DIR/package.json', source, env, workspaces), '$DSH_PROFILE_DIR/package.json')
    assert.equal(sanitizeRestoreTarget('$WORKSPACE:proj/project.txt', source, env, workspaces), '$WORKSPACE:proj/project.txt')
    // 落在允许根内的绝对路径 → 重新编码
    assert.equal(sanitizeRestoreTarget(join(env.profileDir, 'cordis.patch.yml'), source, env, workspaces), '$DSH_PROFILE_DIR/cordis.patch.yml')
    // 未知 workspace 编码串 → 退回
    assert.equal(sanitizeRestoreTarget('$WORKSPACE:unknown/a', source, env, workspaces), '$DSH_HOME/xingxi/config.json')
    // 空 target → 自动编码
    assert.equal(sanitizeRestoreTarget('', source, env, workspaces), '$DSH_HOME/xingxi/config.json')
  } finally {
    cleanup()
  }
})

test('P0-2 makeReadGuard：符号链接不能绕过 deny / 允许范围', () => {
  const { env, workspace, cleanup } = fixtureEnv()
  try {
    // 允许范围内放一个指向 /etc 的符号链接
    const outside = join(tmpdir(), 'dsh-ba-outside-' + process.pid + '-' + Date.now())
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'top-secret\n', 'utf8')
    const linkInHome = join(env.dshHome, 'evil-link')
    symlinkSync(outside, linkInHome)
    // 指向凭据文件的符号链接
    const credLink = join(workspace, 'cred-link.yaml')
    symlinkSync(join(env.dshHome, '.credentials.yaml'), credLink)
    // 指向会话目录的符号链接
    const sessionLink = join(workspace, 'session-link')
    symlinkSync(join(env.dshHome, 'sessions'), sessionLink)

    const workspaces = [{ id: 'w', name: 'proj', path: workspace }]
    const guard = makeReadGuard(env, workspaces)

    assert.equal(guard(join(workspace, 'project.txt')), '', '正常文件应放行')
    assert.ok(guard(join(env.dshHome, 'sessions', 'x.jsonl')), '会话目录应拒绝')
    assert.ok(guard(env.credentialsFile), '凭据文件应拒绝')
    assert.ok(guard(credLink), '指向凭据文件的符号链接应拒绝')
    assert.ok(guard(sessionLink), '指向会话目录的符号链接应拒绝')
    // 允许范围内 → 链接到允许范围外：必须拒绝
    assert.ok(guard(join(linkInHome, 'secret.txt')), '指向允许范围外的符号链接应拒绝')
    assert.ok(guard(linkInHome), '指向允许范围外的符号链接目录应拒绝')
    rmSync(outside, { recursive: true, force: true })
  } finally {
    cleanup()
  }
})

test('P0-3 路由 fail-closed：connection 服务缺失时拒绝请求', async () => {
  const routes = []
  const fakeCtx = {
    get: () => undefined, // 模拟没有 connection 服务
    effect: (fn) => {
      const disposer = typeof fn === 'function' ? fn() : undefined
      return { dispose: () => (typeof disposer === 'function' ? disposer() : undefined) }
    },
    webServer: { register: (route) => routes.push(route) },
  }
  const runtimeStub = { getState: () => ({ ok: true }), getLog: () => ({ ok: true }), version: 'x', getAiSettings: () => ({}), startSnapshot: () => ({ ok: true }) }
  registerRoutes(fakeCtx, runtimeStub)
  assert.equal(routes.length, 1)
  const handler = routes[0].handler
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = String(body || '')
    },
  }
  await handler({ method: 'GET', url: '/dsh-backup-all/state', headers: {} }, res)
  assert.equal(res.status, 500, 'connection 缺失必须 fail-closed')
  assert.match(res.body, /auth service unavailable/)
})

test('P1-1 abort：缺少/不匹配 runId 时拒绝，匹配时才允许', async () => {
  const http = await import('node:http')
  const { createBackupRuntime } = await import('../lib/runner.js')
  const { env, cleanup } = fixtureEnv()
  const slow = http.createServer((req, res) => {
    if (req.method === 'GET' && String(req.url).endsWith('/models')) {
      res.writeHead(200)
      res.end('{"data":[]}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': waiting\n\n')
    const timer = setTimeout(() => res.end(), 15000)
    req.on('close', () => clearTimeout(timer))
  })
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve))
  const port = slow.address().port
  try {
    const runtime = createBackupRuntime({ get: () => undefined, logger: () => ({}) }, { paths: { dshHome: env.dshHome, profileName: 'web', profileDir: env.profileDir, homeDir: env.homeDir, backupDir: env.backupDir, dataDir: env.dataDir } })
    runtime.saveSettings({ baseURL: 'http://127.0.0.1:' + port + '/v1', protocol: 'openai-completions', apiKey: 'k', modelId: 'slow', contextWindowValue: 100, contextWindowUnit: 'K', maxOutputValue: 8, maxOutputUnit: 'K', effort: 'max' })
    const started = runtime.startSnapshot({ name: 'abort 安全测试', description: '' })
    assert.equal(started.ok, true, started.error)
    await new Promise((resolve) => setTimeout(resolve, 600))
    // 缺 runId / 错误 runId：都拒绝
    assert.equal(runtime.abortRun({}).ok, false)
    assert.equal(runtime.abortRun({ runId: 'wrong-run-id' }).ok, false)
    assert.equal(runtime.getState().run.status, 'running', '非法 abort 不能影响任务')
    // 正确 runId：允许
    assert.equal(runtime.abortRun({ runId: started.runId }).ok, true)
    for (let i = 0; i < 60 && runtime.getState().run.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(runtime.getState().run.status, 'interrupted')
    runtime.dispose()
  } finally {
    await new Promise((resolve) => slow.close(resolve))
    cleanup()
  }
})

test('restore 路径安全：篡改 target 不写系统路径（自动落到 fallback），正常条目按 source/允许范围写回', async () => {
  const { env, workspace, cleanup } = fixtureEnv()
  try {
    const extractedDir = join(env.dataDir, 'extracted')
    mkdirSync(join(extractedDir, 'files'), { recursive: true })
    writeFileSync(join(extractedDir, 'files', 'evil'), 'pwned\n', 'utf8')
    writeFileSync(join(extractedDir, 'files', 'ok'), 'good\n', 'utf8')
    writeFileSync(join(extractedDir, 'files', 'ext'), 'external\n', 'utf8')
    const outsideDir = join(env.homeDir, 'outside-data')
    mkdirSync(outsideDir, { recursive: true })
    const outsideFile = join(outsideDir, 'data.txt')
    writeFileSync(outsideFile, 'old\n', 'utf8')
    const manifest = {
      entries: [
        // 篡改：target 指到 /etc/cron.d/evil，source 是无关文件 → 必须改写到安全 fallback，绝不能写 /etc
        { kind: 'external', source: join(env.homeDir, 'legit.txt'), target: '/etc/cron.d/evil', archivePath: 'files/evil', isDirectory: false },
        // 正常：workspace 内目标 → 允许
        { kind: 'external', source: join(workspace, 'project.txt'), target: join(workspace, 'project.txt'), archivePath: 'files/ok', isDirectory: false, sha256: '' },
        // 正常：外部文件本机原位置存在 → 允许写回原处
        { kind: 'external', source: outsideFile, target: outsideFile, archivePath: 'files/ext', isDirectory: false },
      ],
    }
    const tools = createRestoreTools({
      env,
      extractedDir,
      manifest,
      plan: null,
      restoreDoc: '',
      workspaces: [{ id: 'w', name: 'proj', path: workspace }],
      setProgress: () => {},
      log: () => {},
      setFinished: () => {},
      safetyDir: join(env.dataDir, 'restore-safety', 't'),
    })
    const applyTool = tools.tools.find((tool) => tool.name === 'restore_apply_files')
    const result = JSON.parse(await applyTool.execute({}))
    // 三条都应该写回，但第一条被重映射到 <DSH_HOME>/restore-external，而不是 /etc
    assert.equal(result.applied, 3)
    assert.equal(result.failed, 0)
    assert.ok(!existsSync('/etc/cron.d/evil'), 'must never write injected system path')
    const evilResult = result.results.find((item) => item.remap && item.remap.original === '/etc/cron.d/evil')
    assert.ok(evilResult, 'tampered target must be remapped')
    assert.ok(evilResult.target.startsWith(join(env.dshHome, 'restore-external')), 'fallback lands inside current DSH home')
    assert.equal(readFileSync(join(workspace, 'project.txt'), 'utf8'), 'good\n')
    assert.equal(readFileSync(outsideFile, 'utf8'), 'external\n')
  } finally {
    cleanup()
  }
})

test('恢复自保：写回 profile package.json / cordis.patch.yml 时保留 dsh-backup-all 自身', async () => {
  const { env, workspace, cleanup } = fixtureEnv()
  try {
    // 当前 profile 模拟「本插件已安装」：dependencies 里有 dsh-backup-all
    writeFileSync(join(env.profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-fixture',
      dependencies: { 'dsh-backup-all': 'link:/tmp/somewhere/dsh-backup-all', 'dsh-xingxi': '1.0.0' },
      dsh: { profile: { bundles: ['dsh-backup-all', 'dsh-xingxi'] } },
    }, null, 2), 'utf8')
    writeFileSync(join(env.profileDir, 'cordis.patch.yml'), '- id: xingxi\n  name: dsh-xingxi\n', 'utf8')

    const extractedDir = join(env.dataDir, 'extracted-self')
    mkdirSync(join(extractedDir, 'files'), { recursive: true })
    // 假装这是「本插件安装之前」的旧快照：没有 dsh-backup-all 的依赖/行
    writeFileSync(join(extractedDir, 'files', 'pkg'), JSON.stringify({
      name: 'restored-profile',
      dependencies: { 'dsh-xingxi': '0.9.0' },
      dsh: { profile: { bundles: ['dsh-xingxi'] } },
    }, null, 2), 'utf8')
    writeFileSync(join(extractedDir, 'files', 'patch'), '- id: xingxi\n  name: dsh-xingxi\n', 'utf8')
    const manifest = {
      environment: { dshHome: env.dshHome, profileDir: env.profileDir, homeDir: env.homeDir },
      workspaces: [],
      entries: [
        { kind: 'config', source: join(env.profileDir, 'package.json'), target: join(env.profileDir, 'package.json'), archivePath: 'files/pkg', isDirectory: false },
        { kind: 'config', source: join(env.profileDir, 'cordis.patch.yml'), target: join(env.profileDir, 'cordis.patch.yml'), archivePath: 'files/patch', isDirectory: false },
      ],
    }
    const logs = []
    const tools = createRestoreTools({
      env,
      extractedDir,
      manifest,
      plan: null,
      restoreDoc: '',
      workspaces: [{ id: 'w', name: 'proj', path: workspace }],
      setProgress: () => {},
      log: (text) => logs.push(text),
      setFinished: () => {},
      safetyDir: join(env.dataDir, 'restore-safety', 'self'),
    })
    const applyTool = tools.tools.find((tool) => tool.name === 'restore_apply_files')
    const result = JSON.parse(await applyTool.execute({}))
    assert.equal(result.ok, true)
    assert.equal(result.applied, 2)
    assert.ok(result.results.some((item) => item.preservedSelf && item.preservedSelf.includes('本插件')))

    const pkg = JSON.parse(readFileSync(join(env.profileDir, 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'restored-profile', '其它恢复内容保留')
    assert.equal(pkg.dependencies['dsh-backup-all'], 'link:/tmp/somewhere/dsh-backup-all', '保留当前机器的安装 spec')
    assert.ok(pkg.dsh.profile.bundles.includes('dsh-backup-all'), '保留 bundle 选择')
    assert.equal(pkg.dependencies['dsh-xingxi'], '0.9.0', '旧快照内容照常恢复')

    // cordis.patch.yml 不再做文本追加（本插件以 bundle 方式安装，行由 bundle patch 提供；
    // 旧快照的 patch 内容应原样恢复，避免破坏 [] 模板或与 bundle 行重复）
    const patch = readFileSync(join(env.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.equal(patch, '- id: xingxi\n  name: dsh-xingxi\n', '旧 patch 内容原样恢复、不追加')
    assert.ok(!patch.includes('dsh-backup-all'), '不向 patch 追加入侵行')
  } finally {
    cleanup()
  }
})
