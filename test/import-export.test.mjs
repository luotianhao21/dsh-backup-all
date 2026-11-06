// v1.1.0：导入/导出快照（runtime + HTTP 路由，流式、大小限制、OS 识别、文件名清洗）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable, PassThrough } from 'node:stream'

import { createBackupRuntime } from '../lib/runner.js'
import { registerRoutes } from '../lib/routes.js'
import { packDirectoryBrotli } from '../lib/archive.js'
import { resolveEnv } from '../lib/paths.js'

function makeBase() {
  const base = join(tmpdir(), 'dsh-ba-import-' + randomUUID())
  const dshHome = join(base, 'home')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  return { base, dshHome, profileDir }
}

async function makeArchive(base, { osType = 'linux', name = 'archive' } = {}) {
  const src = join(base, 'src-' + name)
  mkdirSync(join(src, 'files'), { recursive: true })
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({
    formatVersion: 1,
    generator: 'dsh-backup-all',
    createdAt: new Date().toISOString(),
    environment: { dshHome: '/old/.dsh', profileDir: '/old/.dsh/profiles/web', homeDir: '/old', osType },
    entries: [],
    plugins: [],
  }), 'utf8')
  writeFileSync(join(src, 'files', 'a.txt'), 'hello import\n', 'utf8')
  const out = join(base, 'upload-' + name + '.backup.tar.br')
  await packDirectoryBrotli({ sourceDir: src, outFile: out })
  return out
}

function fakeCtx() {
  const captured = { handler: null }
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
    effect(fn) {
      return fn()
    },
    logger: () => ({ info() {}, error() {} }),
    webServer: {
      register(opts) {
        captured.handler = opts.handler
        return () => {}
      },
    },
  }
  return { ctx, captured }
}

function makeRuntime(base, dshHome, profileDir) {
  const { ctx } = fakeCtx()
  return createBackupRuntime(ctx, {
    paths: {
      dshHome,
      profileName: 'web',
      profileDir,
      homeDir: join(base, 'user'),
      backupDir: join(base, 'backup'),
      dataDir: join(base, 'data'),
      osType: 'linux',
    },
    testHooks: { reinstallDependencies: async () => ({ ok: true, command: 'fake', exitCode: 0, outputTail: '' }) },
  })
}

test('importSnapshot：识别 manifest osType、默认名去后缀、移入 backup、可重复导入不冲突', async () => {
  const { base, dshHome, profileDir } = makeBase()
  try {
    const runtime = makeRuntime(base, dshHome, profileDir)
    const archive = await makeArchive(base, { osType: 'windows', name: 'w' })
    const r1 = await runtime.importSnapshot({
      tempFile: archive,
      originalFilename: '2026-11-06 10-30-00-windows.backup.tar.br',
      name: '',
      description: '导入测试',
    })
    assert.equal(r1.ok, true, JSON.stringify(r1))
    assert.equal(r1.record.osType, 'windows')
    assert.equal(r1.record.imported, true)
    assert.equal(r1.record.name, '2026-11-06 10-30-00-windows')
    assert.equal(r1.record.file, '2026-11-06 10-30-00-windows.backup.tar.br')
    assert.ok(existsSync(join(runtime.env.backupDir, r1.record.file)))

    const archive2 = await makeArchive(base, { osType: 'linux', name: 'l' })
    const r2 = await runtime.importSnapshot({
      tempFile: archive2,
      originalFilename: '2026-11-06 10-30-00-windows.backup.tar.br',
      name: '第二个',
      description: '',
    })
    assert.equal(r2.ok, true)
    assert.equal(r2.record.name, '第二个')
    assert.notEqual(r2.record.file, r1.record.file, '同名导入应自动加 -n')
    assert.ok(existsSync(join(runtime.env.backupDir, r2.record.file)))
    const listed = runtime.getState().records
    assert.equal(listed.length, 2)
    assert.ok(listed.every((x) => x.imported === true))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('importSnapshot：非法归档拒绝且不留垃圾文件', async () => {
  const { base, dshHome, profileDir } = makeBase()
  try {
    const runtime = makeRuntime(base, dshHome, profileDir)
    const bad = join(base, 'bad.backup.tar.br')
    writeFileSync(bad, 'not brotli data', 'utf8')
    const r = await runtime.importSnapshot({ tempFile: bad, originalFilename: 'bad.backup.tar.br', name: '', description: '' })
    assert.equal(r.ok, false)
    assert.match(String(r.error), /不是有效的快照归档|manifest/)
    assert.equal(existsSync(bad), false, '失败后临时文件应被清理')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('HTTP 路由：POST /snapshot/import 之后再 GET /snapshot/export 流式下载一致', async () => {
  const { base, dshHome, profileDir } = makeBase()
  try {
    const runtime = makeRuntime(base, dshHome, profileDir)
    const { ctx, captured } = fakeCtx()
    registerRoutes(ctx, runtime)
    const handler = captured.handler
    assert.equal(typeof handler, 'function')

    const archive = await makeArchive(base, { osType: 'linux', name: 'route' })
    const bytes = readFileSync(archive)
    const req = Readable.from([bytes])
    req.method = 'POST'
    req.url = '/dsh-backup-all/snapshot/import'
    req.headers = {
      'content-length': String(bytes.length),
      'x-snapshot-filename': encodeURIComponent('2026-11-06 11-00-00-linux.backup.tar.br'),
      'x-snapshot-name': encodeURIComponent('路由导入'),
      'x-snapshot-description': encodeURIComponent('route test'),
    }
    const res = new PassThrough()
    res.statusCode = 0
    res.headers = {}
    res.writeHead = (status, headers) => {
      res.statusCode = status
      res.headers = headers || {}
    }
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    const done = new Promise((resolve) => res.on('end', resolve))
    await handler(req, res)
    await done
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(payload.ok, true, JSON.stringify(payload))
    const record = payload.record
    assert.equal(record.osType, 'linux')

    const req2 = Readable.from([])
    req2.method = 'GET'
    req2.url = '/dsh-backup-all/snapshot/export?id=' + encodeURIComponent(record.id)
    req2.headers = {}
    const res2 = new PassThrough()
    res2.headers = {}
    res2.writeHead = (status, headers) => {
      res2.statusCode = status
      res2.headers = headers || {}
    }
    const chunks2 = []
    res2.on('data', (c) => chunks2.push(c))
    const done2 = new Promise((resolve) => res2.on('end', resolve))
    await handler(req2, res2)
    await done2
    assert.equal(res2.statusCode, 200)
    assert.equal(res2.headers['content-type'], 'application/octet-stream')
    assert.match(String(res2.headers['content-disposition']), /^attachment; filename\*=UTF-8''/)
    const downloaded = Buffer.concat(chunks2)
    assert.equal(downloaded.length, bytes.length)
    assert.deepEqual(downloaded, bytes)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
