// 路径自动重映射 + 快照策略相关测试（对应本轮新增需求）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveRestoreTarget } from '../lib/paths.js'

function fixture() {
  const base = join(tmpdir(), 'dsh-ba-remap-' + process.pid + '-' + Date.now())
  const env = {
    dshHome: join(base, 'new-home', '.dsh'),
    profileDir: join(base, 'new-home', '.dsh', 'profiles', 'web'),
    homeDir: join(base, 'new-home'),
  }
  mkdirSync(env.profileDir, { recursive: true })
  mkdirSync(join(env.homeDir, 'work', 'proj-b'), { recursive: true })
  const workspaces = [{ id: 'w', name: 'proj-b', path: join(env.homeDir, 'work', 'proj-b') }]
  const oldEnvironment = {
    dshHome: '/old-root/.dsh',
    profileDir: '/old-root/.dsh/profiles/web',
    homeDir: '/old-root',
    workspaces: [{ id: 'w', name: 'proj-a', path: '/old-root/projects/proj-a' }],
  }
  return { base, env, workspaces, oldEnvironment, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('占位符目标按当前环境直接展开（无需重映射）', () => {
  const { env, workspaces, oldEnvironment, cleanup } = fixture()
  try {
    const cases = [
      [{ target: '$DSH_PROFILE_DIR/package.json', source: '/old-root/.dsh/profiles/web/package.json' }, join(env.profileDir, 'package.json'), 'placeholder'],
      [{ target: '$DSH_HOME/xingxi', source: '/old-root/.dsh/xingxi' }, join(env.dshHome, 'xingxi'), 'placeholder'],
    ]
    for (const [entry, expected, mode] of cases) {
      const result = resolveRestoreTarget(entry, oldEnvironment, env, workspaces)
      assert.equal(result.ok, true)
      assert.equal(result.target, expected)
      assert.equal(result.remapped, false)
      assert.equal(result.mode, mode)
    }
  } finally {
    cleanup()
  }
})

test('外部绝对路径：旧 homeDir / old workspace 前缀自动重映射', () => {
  const { env, workspaces, oldEnvironment, cleanup } = fixture()
  try {
    // 旧 homeDir 下的普通外部数据
    let result = resolveRestoreTarget({ target: '/old-root/my-data/file.txt', source: '/old-root/my-data/file.txt' }, oldEnvironment, env, workspaces)
    assert.equal(result.ok, true)
    assert.equal(result.target, join(env.homeDir, 'my-data', 'file.txt'))
    assert.equal(result.remapped, true)
    assert.equal(result.mode, 'homeDir-remap')

    // 旧 workspace（名字不同、basename 不同 → 走 workspace-remap 需要 basename 匹配；这里用相同 basename）
    const sameBaseEnv = {
      ...oldEnvironment,
      workspaces: [{ id: 'w', name: 'old-name', path: '/old-root/projects/proj-b' }],
    }
    result = resolveRestoreTarget({ target: '/old-root/projects/proj-b/a.txt', source: '/old-root/projects/proj-b/a.txt' }, sameBaseEnv, env, workspaces)
    assert.equal(result.ok, true)
    assert.equal(result.target, join(env.homeDir, 'work', 'proj-b', 'a.txt'))
    assert.equal(result.remapped, true)
    assert.equal(result.mode, 'workspace-remap')
  } finally {
    cleanup()
  }
})

test('无法映射的外部路径落到 <DSH_HOME>/restore-external 并标记 fallback', () => {
  const { env, workspaces, oldEnvironment, cleanup } = fixture()
  try {
    const result = resolveRestoreTarget({ target: '/opt/some-vendor/data.bin', source: '/opt/some-vendor/data.bin' }, oldEnvironment, env, workspaces)
    assert.equal(result.ok, true)
    assert.equal(result.remapped, true)
    assert.equal(result.mode, 'fallback')
    assert.ok(result.target.startsWith(join(env.dshHome, 'restore-external')))
    assert.match(result.reason, /fallback|确认/)
  } finally {
    cleanup()
  }
})

test('$WORKSPACE 名字对不上时按旧目录名匹配当前 workspace', () => {
  const { env, workspaces, oldEnvironment, cleanup } = fixture()
  try {
    // 旧 workspace 名字 old-name、旧目录名 proj-b → 当前 workspace 名字 proj-b
    const oldEnvironment2 = {
      ...oldEnvironment,
      workspaces: [{ id: 'w', name: 'old-name', path: '/old-root/projects/proj-b' }],
    }
    const result = resolveRestoreTarget({ target: '$WORKSPACE:old-name/notes/a.md', source: '/old-root/projects/proj-b/notes/a.md' }, oldEnvironment2, env, workspaces)
    assert.equal(result.ok, true)
    assert.equal(result.remapped, true)
    assert.equal(result.mode, 'workspace-remap')
    assert.equal(result.target, join(workspaces[0].path, 'notes', 'a.md'))
  } finally {
    cleanup()
  }
})

test('拒绝注入到系统路径（target 与 source 都被篡改也不写出允许范围）', () => {
  const { env, workspaces, oldEnvironment, cleanup } = fixture()
  try {
    const result = resolveRestoreTarget({ target: '/etc/cron.d/evil', source: '/etc/cron.d/evil' }, oldEnvironment, env, workspaces)
    // /etc 不在允许根、也不是旧 home 前缀 → 落到 fallback（而不是原样写 /etc）
    assert.equal(result.ok, true)
    assert.equal(result.remapped, true)
    assert.equal(result.mode, 'fallback')
    assert.notEqual(result.target, '/etc/cron.d/evil')
    assert.ok(result.target.startsWith(join(env.dshHome, 'restore-external')))
  } finally {
    cleanup()
  }
})

test('快照策略默认值：local-only + 打包凭据；保存后可改', async () => {
  const { base, env, workspaces, cleanup } = fixture()
  try {
    const { createBackupRuntime } = await import('../lib/runner.js')
    const runtime = createBackupRuntime(
      { get: () => undefined, logger: () => ({}) },
      { paths: { dshHome: env.dshHome, profileName: 'web', profileDir: env.profileDir, homeDir: env.homeDir, backupDir: join(base, 'backup'), dataDir: join(base, 'data') } },
    )
    const state = runtime.getState()
    assert.equal(state.settings.snapshot.packPluginCode, 'local-only')
    assert.equal(state.settings.snapshot.excludeCredentials, false)
    const saved = runtime.saveSettings({ snapshot: { packPluginCode: 'all', excludeCredentials: true } })
    assert.equal(saved.ok, true)
    assert.equal(saved.settings.snapshot.packPluginCode, 'all')
    assert.equal(saved.settings.snapshot.excludeCredentials, true)
    // 非法值回退默认
    const fallback = runtime.saveSettings({ snapshot: { packPluginCode: 'bogus' } })
    assert.equal(fallback.settings.snapshot.packPluginCode, 'local-only')
    runtime.dispose()
  } finally {
    cleanup()
  }
})

test('策略切换会写入 manifest（none + 不打包凭据）', async () => {
  // 这个行为由 host-e2e 的「策略」用例覆盖；这里只校验纯函数级策略默认值与字段存在
  const { DEFAULT_SNAPSHOT_POLICY, publicSnapshotSettings } = await import('../lib/store.js')
  assert.deepEqual(DEFAULT_SNAPSHOT_POLICY, { packPluginCode: 'local-only', excludeCredentials: false, crossOsPluginCode: 'skip' })
  assert.deepEqual(publicSnapshotSettings({ packPluginCode: 'none', excludeCredentials: true }), {
    packPluginCode: 'none',
    excludeCredentials: true,
    crossOsPluginCode: 'skip',
  })
})
