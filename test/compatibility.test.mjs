// v1.1.0：OS 兼容性矩阵 / 跨 OS 恢复限制强制执行 / 符号链接策略 / 双平台文档与提示词
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { buildCompatibility } from '../lib/compatibility.js'
import { createRestoreTools } from '../lib/tools-restore.js'
import { classifyPluginCodeDir } from '../lib/plugin-code.js'
import { publicSnapshotSettings } from '../lib/store.js'
import { resolveEnv, resolveRestoreTarget } from '../lib/paths.js'
import { renderRestoreDoc } from '../lib/restore-doc.js'
import { packDirectoryBrotli, extractArchive } from '../lib/archive.js'
import { renderSnapshotUserPrompt, renderRestoreUserPrompt } from '../lib/prompts.js'

function base(prefix) {
  const b = join(tmpdir(), 'dsh-ba-' + prefix + '-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  mkdirSync(b, { recursive: true })
  return b
}

test('buildCompatibility：六种矩阵 mode/strategy/restrictions', () => {
  const cases = [
    ['linux', 'linux', 'same-linux', 'full', true],
    ['windows', 'windows', 'same-windows', 'full-windows', true],
    ['linux', 'windows', 'linux-to-windows', 'compat-linux-to-windows', true],
    ['windows', 'linux', 'windows-to-linux', 'compat-windows-to-linux', true],
    ['unknown', 'linux', 'unknown', 'compat-linux-to-windows', true],
    ['other', 'other', 'unknown', 'compat-linux-to-windows', true],
  ]
  for (const [snap, cur, mode, strategy, supported] of cases) {
    const c = buildCompatibility({ osType: snap }, { osType: cur })
    assert.equal(c.snapshotOs, snap)
    assert.equal(c.currentOs, cur)
    assert.equal(c.mode, mode, JSON.stringify(c))
    assert.equal(c.strategy, strategy, JSON.stringify(c))
    assert.equal(c.supported, supported, JSON.stringify(c))
  }
  const compat = buildCompatibility({ osType: 'linux' }, { osType: 'windows' })
  assert.ok(compat.restrictions.includes('skip-plugin-code'))
  assert.ok(compat.restrictions.includes('skip-symlinks'))
  assert.ok(compat.notes.length > 0)
})

function crossOsFixture(currentOs) {
  const dir = base('crossos')
  const dshHome = join(dir, 'home')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const extracted = join(dir, 'extracted')
  mkdirSync(join(extracted, 'files', 'plugin'), { recursive: true })
  writeFileSync(join(extracted, 'files', 'config.json'), '{"a":1}\n', 'utf8')
  writeFileSync(join(extracted, 'files', 'plugin', 'index.js'), 'export const x = 1\n', 'utf8')
  const env = resolveEnv({
    dshHome, profileName: 'web', profileDir, homeDir: join(dir, 'user'),
    backupDir: join(dir, 'backup'), dataDir: join(dir, 'data'), osType: currentOs,
  })
  const manifest = {
    environment: { osType: 'linux', dshHome: '/old/.dsh', profileDir: '/old/.dsh/profiles/web', homeDir: '/old' },
    workspaces: [],
    entries: [
      { kind: 'config', source: join(profileDir, 'cordis.yml'), target: '$DSH_PROFILE_DIR/cordis.yml', archivePath: 'files/config.json', isDirectory: false },
      { kind: 'plugin-code', source: '/old/.dsh/dshbox/plugins/x/plugin', target: '$DSH_HOME/dshbox/plugins/x/plugin', archivePath: 'files/plugin', isDirectory: true },
    ],
    plugins: [],
  }
  return { dir, env, extracted, manifest, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('restore_compare/apply：Linux→Windows 兼容策略跳过 plugin-code，正常写配置', async () => {
  const fx = crossOsFixture('windows')
  try {
    const tools = createRestoreTools({
      env: fx.env, extractedDir: fx.extracted, manifest: fx.manifest, plan: null, restoreDoc: '',
      workspaces: [], setProgress: () => {}, log: () => {}, setFinished: () => {},
      safetyDir: join(fx.dir, 'safety'),
    })
    const compare = JSON.parse(await tools.tools.find((t) => t.name === 'restore_compare').execute({}))
    assert.equal(compare.compatibility.strategy, 'compat-linux-to-windows')
    const applied = JSON.parse(await tools.tools.find((t) => t.name === 'restore_apply_files').execute({}))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.applied, 1)
    assert.equal(applied.skipped.length, 1)
    assert.equal(applied.skipped[0].kind, 'plugin-code')
    assert.ok(applied.warnings.some((w) => /skip-plugin-code/.test(w)))
    assert.ok(existsSync(join(fx.env.profileDir, 'cordis.yml')))
    assert.equal(existsSync(join(fx.env.dshHome, 'dshbox/plugins/x/plugin/index.js')), false)
  } finally {
    fx.cleanup()
  }
})

test('restore_apply_files：Windows→Linux 兼容策略跳过 plugin-code、正常写配置', async () => {
  const fx = crossOsFixture('linux')
  try {
    fx.manifest.environment.osType = 'windows'
    const tools = createRestoreTools({
      env: fx.env, extractedDir: fx.extracted, manifest: fx.manifest, plan: null, restoreDoc: '',
      workspaces: [], setProgress: () => {}, log: () => {}, setFinished: () => {},
      safetyDir: join(fx.dir, 'safety'),
    })
    const compare = JSON.parse(await tools.tools.find((t) => t.name === 'restore_compare').execute({}))
    assert.equal(compare.compatibility.strategy, 'compat-windows-to-linux')
    assert.equal(compare.compatibility.supported, true)
    const applied = JSON.parse(await tools.tools.find((t) => t.name === 'restore_apply_files').execute({}))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.applied, 1)
    assert.equal(applied.skipped.length, 1)
    assert.equal(applied.skipped[0].kind, 'plugin-code')
    assert.ok(existsSync(join(fx.env.profileDir, 'cordis.yml')))
    assert.equal(existsSync(join(fx.env.dshHome, 'dshbox/plugins/x/plugin/index.js')), false)
  } finally {
    fx.cleanup()
  }
})

test('跨 OS 恢复（Windows→Linux）package.json：自身 spec 统一 + 移除 Windows 绝对本地依赖', async () => {
  const dir = base('winpkg')
  try {
    const dshHome = join(dir, 'home')
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'p', dependencies: { 'dsh-backup-all': 'link:/opt/current/plugin' }, dsh: { profile: { bundles: ['dsh-backup-all'] } },
    }, null, 2), 'utf8')
    const extracted = join(dir, 'extracted')
    mkdirSync(join(extracted, 'files'), { recursive: true })
    writeFileSync(join(extracted, 'files', 'pkg'), JSON.stringify({
      name: 'p',
      dependencies: { 'dsh-backup-all': 'link:C:/work/plugin', '@local/win-only': 'link:C:/work/win-only', 'reg-pkg': '^2.0.0' },
      dsh: { profile: { bundles: ['@local/win-only', 'reg-pkg'] } },
    }, null, 2), 'utf8')
    const env = resolveEnv({ dshHome, profileName: 'web', profileDir, homeDir: join(dir, 'user'), backupDir: join(dir, 'backup'), dataDir: join(dir, 'data'), osType: 'linux' })
    const manifest = {
      environment: { osType: 'windows', dshHome: 'C:/Users/x/.dsh', profileDir: 'C:/Users/x/.dsh/profiles/web', homeDir: 'C:/Users/x' },
      workspaces: [],
      entries: [{ kind: 'config', source: join(profileDir, 'package.json'), target: '$DSH_PROFILE_DIR/package.json', archivePath: 'files/pkg', isDirectory: false }],
      plugins: [],
    }
    const tools = createRestoreTools({ env, extractedDir: extracted, manifest, plan: null, restoreDoc: '', workspaces: [], setProgress: () => {}, log: () => {}, setFinished: () => {}, safetyDir: join(dir, 'safety') })
    const applied = JSON.parse(await tools.tools.find((t) => t.name === 'restore_apply_files').execute({}))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    const out = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.equal(out.dependencies['dsh-backup-all'], 'link:/opt/current/plugin')
    assert.equal(out.dependencies['@local/win-only'], undefined)
    assert.equal(out.dependencies['reg-pkg'], '^2.0.0')
    assert.ok(out.dsh.profile.bundles.includes('dsh-backup-all') && out.dsh.profile.bundles.includes('reg-pkg'))
    assert.ok(!out.dsh.profile.bundles.includes('@local/win-only'))
    assert.ok(applied.warnings.some((w) => /跨 OS/.test(w)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('跨 OS 恢复：Windows 盘符绝对路径在 Linux 上 fallback 到 restore-external', () => {
  if (process.platform === 'win32') return // Windows 上该路径会走 homeDir-remap，本断言只验证 Linux 行为
  const env = resolveEnv({ dshHome: '/target/.dsh', profileName: 'web', profileDir: '/target/.dsh/profiles/web', homeDir: '/target/user', osType: 'linux' })
  const r = resolveRestoreTarget(
    { target: 'C:\\Users\\x\\data\\notes.txt', source: 'C:/Users/x/data/notes.txt' },
    { osType: 'windows', dshHome: 'C:/Users/x/.dsh', profileDir: 'C:/Users/x/.dsh/profiles/web', homeDir: 'C:/Users/x' },
    env,
    [],
  )
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'fallback')
  assert.match(String(r.target), /restore-external/)
})

test('extractArchive symlinkPolicy：skip 跳过并 warning；copy 复制内容；auto 建链接', async () => {
  const dir = base('symlink')
  try {
    const src = join(dir, 'src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'target.txt'), 'content-123\n', 'utf8')
    symlinkSync('target.txt', join(src, 'link.txt'))
    const archive = join(dir, 'a.backup.tar.br')
    await packDirectoryBrotli({ sourceDir: src, outFile: archive })

    const skipDir = join(dir, 'skip')
    const skip = await extractArchive({ archiveFile: archive, destDir: skipDir, symlinkPolicy: 'skip' })
    assert.equal(existsSync(join(skipDir, 'link.txt')), false)
    assert.ok(skip.warnings.length > 0)

    const copyDir = join(dir, 'copy')
    await extractArchive({ archiveFile: archive, destDir: copyDir, symlinkPolicy: 'copy' })
    assert.equal(readFileSync(join(copyDir, 'link.txt'), 'utf8'), 'content-123\n')
    assert.equal((await import('node:fs')).lstatSync(join(copyDir, 'link.txt')).isSymbolicLink(), false)

    const autoDir = join(dir, 'auto')
    await extractArchive({ archiveFile: archive, destDir: autoDir, symlinkPolicy: 'auto' })
    assert.equal((await import('node:fs')).lstatSync(join(autoDir, 'link.txt')).isSymbolicLink(), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RESTORE.md 双平台：Windows 快照有 PowerShell；任意快照有跨 OS 兼容节', () => {
  const manifestBase = {
    createdAt: new Date().toISOString(),
    workspaces: [],
    entries: [],
    plugins: [],
    snapshotPolicy: { packPluginCode: 'local-only', credentialsIncluded: false, pluginCodePacked: [] },
    credentialsIncluded: false,
    configFiles: [], skills: [], skillRoots: [], patchRows: [], mcpRows: [], presetRows: [], excluded: [], warnings: [],
  }
  const winDoc = renderRestoreDoc({
    record: { name: 'win', createdAt: new Date().toISOString() },
    manifest: { ...manifestBase, environment: { osType: 'windows', platform: 'win32', homeDir: 'C:\\Users\\x', dshHome: 'C:\\Users\\x\\.dsh', profileDir: 'C:\\Users\\x\\.dsh\\profiles\\web', profileName: 'web' } },
    plan: null, aiDoc: '',
  })
  assert.match(winDoc, /PowerShell/)
  assert.match(winDoc, /Windows/)
  assert.match(winDoc, /跨操作系统兼容恢复/)

  const linDoc = renderRestoreDoc({
    record: { name: 'lin', createdAt: new Date().toISOString() },
    manifest: { ...manifestBase, environment: { osType: 'linux', platform: 'linux', homeDir: '/root', dshHome: '/root/.dsh', profileDir: '/root/.dsh/profiles/web', profileName: 'web' } },
    plan: null, aiDoc: '',
  })
  assert.match(linDoc, /跨操作系统兼容恢复/)
  assert.doesNotMatch(linDoc, /Windows（PowerShell）/)
})

test('用户提示词注入当前 OS 与 compatibility 选择要求', () => {
  const env = { osType: 'windows', platform: 'win32', arch: 'x64', osRelease: '10.0.26100', nodeVersion: 'v24.19.0' }
  const snap = renderSnapshotUserPrompt({ snapshotName: 's', description: '', inventory: { counts: {} }, config: { dshHome: '/x', profileName: 'web' }, environment: env })
  assert.match(snap, /当前操作系统/)
  assert.match(snap, /windows/)
  assert.match(snap, /OS 类型/)
  const restore = renderRestoreUserPrompt({
    recordName: 'r', description: '', archivePath: '/x/a.backup.tar.br',
    manifest: { environment: { osType: 'linux' } }, restorePlan: null, currentInventory: null,
    environment: env,
  })
  assert.match(restore, /当前恢复目标系统/)
  assert.match(restore, /restore_compare/)
  assert.match(restore, /compatibility/)
})


test('跨 OS 恢复 package.json：自身 spec 统一到当前机 + 移除目标机不可用的绝对本地依赖', async () => {
  const dir = base('crosspkg')
  try {
    const dshHome = join(dir, 'home')
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    // 当前（Windows 侧）profile：本插件已安装，另有本地依赖
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'p',
      dependencies: { 'dsh-backup-all': 'link:C:/work/plugin', '@local/win-only': 'file:C:/work/win' },
      dsh: { profile: { bundles: ['dsh-backup-all', '@local/win-only'] } },
    }, null, 2), 'utf8')
    const extracted = join(dir, 'extracted')
    mkdirSync(join(extracted, 'files'), { recursive: true })
    // 快照（Linux 侧）的 package.json：本插件与本地依赖都是 Linux 绝对路径
    writeFileSync(join(extracted, 'files', 'pkg'), JSON.stringify({
      name: 'p',
      dependencies: { 'dsh-backup-all': 'link:/opt/fixtures/plugin', '@local/linux-only': 'link:/opt/fixtures/linux-only', 'reg-pkg': '^1.0.0' },
      dsh: { profile: { bundles: ['@local/linux-only', 'reg-pkg'] } },
    }, null, 2), 'utf8')
    const env = resolveEnv({ dshHome, profileName: 'web', profileDir, homeDir: join(dir, 'user'), backupDir: join(dir, 'backup'), dataDir: join(dir, 'data'), osType: 'windows' })
    const manifest = {
      environment: { osType: 'linux', dshHome: '/root/.dsh', profileDir: '/root/.dsh/profiles/web', homeDir: '/root' },
      workspaces: [],
      entries: [{ kind: 'config', source: join(profileDir, 'package.json'), target: '$DSH_PROFILE_DIR/package.json', archivePath: 'files/pkg', isDirectory: false }],
      plugins: [],
    }
    const tools = createRestoreTools({
      env, extractedDir: extracted, manifest, plan: null, restoreDoc: '', workspaces: [],
      setProgress: () => {}, log: () => {}, setFinished: () => {},
      safetyDir: join(dir, 'safety'),
    })
    const applied = JSON.parse(await tools.tools.find((t) => t.name === 'restore_apply_files').execute({}))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    const out = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    assert.equal(out.dependencies['dsh-backup-all'], 'link:C:/work/plugin')
    assert.equal(out.dependencies['@local/linux-only'], undefined)
    assert.equal(out.dependencies['reg-pkg'], '^1.0.0')
    assert.ok(!out.dsh.profile.bundles.includes('@local/linux-only'))
    assert.ok(out.dsh.profile.bundles.includes('reg-pkg') && out.dsh.profile.bundles.includes('dsh-backup-all'))
    assert.ok(applied.warnings.some((w) => /跨 OS/.test(w) && /@local\/linux-only/.test(w)), JSON.stringify(applied.warnings))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('跨 OS 恢复：$WORKSPACE 占位符无匹配时落到 restore-external（而非静默 unmapped）', () => {
  const env = resolveEnv({ dshHome: '/target/.dsh', profileName: 'web', profileDir: '/target/.dsh/profiles/web', homeDir: '/target/user', osType: 'windows' })
  const r = resolveRestoreTarget(
    { target: '$WORKSPACE:oldws/data/notes.txt', source: '/old/ws/data/notes.txt' },
    { osType: 'linux', dshHome: '/old/.dsh', profileDir: '/old/.dsh/profiles/web', homeDir: '/old', workspaces: [{ id: 'w', name: 'oldws', path: '/old/ws' }] },
    env,
    [],
  )
  assert.equal(r.ok, true)
  assert.equal(r.mode, 'fallback')
  assert.match(String(r.target), /restore-external/)
  assert.match(String(r.reason), /跨 OS/)
})


test('archive：Windows 风格 0666 目录/文件解包后在 POSIX 可读（补 exec/read 位）', async () => {
  if (process.platform === 'win32') return // 用 GNU tar --mode 造 Windows 风格归档，Windows 上跳过
  const dir = base('winmode')
  try {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'a.txt'), 'alpha\n', 'utf8')
    writeFileSync(join(src, 'sub', 'b.txt'), 'beta\n', 'utf8')
    const tarFile = join(dir, 'raw.tar')
    const { execFileSync } = await import('node:child_process')
    execFileSync('tar', ['--mode=0666', '-cf', tarFile, '-C', src, '.'])
    const { brotliCompressSync } = await import('node:zlib')
    const archive = join(dir, 'win-style.backup.tar.br')
    writeFileSync(archive, brotliCompressSync(readFileSync(tarFile)))
    const dest = join(dir, 'dest')
    await extractArchive({ archiveFile: archive, destDir: dest, symlinkPolicy: 'skip' })
    assert.equal(readFileSync(join(dest, 'a.txt'), 'utf8'), 'alpha\n')
    assert.equal(readFileSync(join(dest, 'sub', 'b.txt'), 'utf8'), 'beta\n')
    const st = (await import('node:fs')).statSync(join(dest, 'sub'))
    assert.ok((st.mode & 0o111) !== 0, '目录应有执行/遍历位：' + (st.mode & 0o777).toString(8))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})



test('settings：crossOsPluginCode 默认 skip，仅接受 skip/js', () => {
  assert.equal(publicSnapshotSettings({}).crossOsPluginCode, 'skip')
  assert.equal(publicSnapshotSettings({ crossOsPluginCode: 'js' }).crossOsPluginCode, 'js')
  assert.equal(publicSnapshotSettings({ crossOsPluginCode: 'hack' }).crossOsPluginCode, 'skip')
})

test('buildCompatibility：启用纯 JS 迁移时 restrictions 变为 plugin-code-js-only', () => {
  const c1 = buildCompatibility({ osType: 'linux' }, { osType: 'windows' }, { crossOsPluginCode: 'js' })
  assert.equal(c1.strategy, 'compat-linux-to-windows')
  assert.ok(c1.restrictions.includes('plugin-code-js-only'))
  assert.ok(!c1.restrictions.includes('skip-plugin-code'))
  const c2 = buildCompatibility({ osType: 'windows' }, { osType: 'linux' }, { crossOsPluginCode: 'skip' })
  assert.ok(c2.restrictions.includes('skip-plugin-code'))
  const c3 = buildCompatibility({ osType: 'linux' }, { osType: 'linux' }, { crossOsPluginCode: 'js' })
  assert.equal(c3.strategy, 'full')
})

test('classifyPluginCodeDir：纯 JS 通过；含 .node / os 不匹配 / gypfile 拒绝', () => {
  const dir = base('classify')
  try {
    const pure = join(dir, 'pure')
    mkdirSync(pure, { recursive: true })
    writeFileSync(join(pure, 'package.json'), JSON.stringify({ name: 'p', main: 'index.js' }), 'utf8')
    writeFileSync(join(pure, 'index.js'), 'export const x = 1\n', 'utf8')
    const r1 = classifyPluginCodeDir(pure, { osType: 'linux' })
    assert.equal(r1.pure, true, JSON.stringify(r1))

    writeFileSync(join(pure, 'addon.node'), 'binary', 'utf8')
    const r2 = classifyPluginCodeDir(pure, { osType: 'linux' })
    assert.equal(r2.pure, false)
    assert.match(String(r2.reason), /原生二进制|\.node/)

    const onlyWin = join(dir, 'onlywin')
    mkdirSync(onlyWin, { recursive: true })
    writeFileSync(join(onlyWin, 'package.json'), JSON.stringify({ name: 'w', os: ['win32'] }), 'utf8')
    writeFileSync(join(onlyWin, 'index.js'), 'module.exports = 1\n', 'utf8')
    const r3 = classifyPluginCodeDir(onlyWin, { osType: 'linux' })
    assert.equal(r3.pure, false)
    assert.match(String(r3.reason), /os 声明/)

    const gyp = join(dir, 'gyp')
    mkdirSync(gyp, { recursive: true })
    writeFileSync(join(gyp, 'package.json'), JSON.stringify({ name: 'g', gypfile: true }), 'utf8')
    writeFileSync(join(gyp, 'index.js'), '1\n', 'utf8')
    const r4 = classifyPluginCodeDir(gyp, { osType: 'linux' })
    assert.equal(r4.pure, false)
    assert.match(String(r4.reason), /gypfile/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restore_apply_files：启用纯 JS 迁移后 plugin-code 通过校验并写回', async () => {
  const fx = crossOsFixture('windows')
  try {
    const tools = createRestoreTools({
      env: fx.env, extractedDir: fx.extracted, manifest: fx.manifest, plan: null, restoreDoc: '',
      workspaces: [], setProgress: () => {}, log: () => {}, setFinished: () => {},
      safetyDir: join(fx.dir, 'safety'), restoreOptions: { crossOsPluginCode: 'js' },
    })
    const compare = JSON.parse(await tools.tools.find((t) => t.name === 'restore_compare').execute({}))
    assert.ok(compare.compatibility.restrictions.includes('plugin-code-js-only'))
    const applied = JSON.parse(await tools.tools.find((t) => t.name === 'restore_apply_files').execute({}))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.applied, 2)
    assert.equal(applied.skipped.length, 0)
    assert.ok(existsSync(join(fx.env.dshHome, 'dshbox/plugins/x/plugin/index.js')))
  } finally {
    fx.cleanup()
  }
})

test('restore_apply_files：启用纯 JS 迁移后含原生二进制的 plugin-code 仍被跳过', async () => {
  const fx = crossOsFixture('windows')
  try {
    writeFileSync(join(fx.extracted, 'files', 'plugin', 'addon.node'), 'binary', 'utf8')
    const tools = createRestoreTools({
      env: fx.env, extractedDir: fx.extracted, manifest: fx.manifest, plan: null, restoreDoc: '',
      workspaces: [], setProgress: () => {}, log: () => {}, setFinished: () => {},
      safetyDir: join(fx.dir, 'safety'), restoreOptions: { crossOsPluginCode: 'js' },
    })
    const applied = JSON.parse(await tools.tools.find((t) => t.name === 'restore_apply_files').execute({}))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.skipped.length, 1)
    assert.equal(applied.skipped[0].kind, 'plugin-code')
    assert.ok(!existsSync(join(fx.env.dshHome, 'dshbox/plugins/x/plugin/index.js')))
    assert.ok(applied.warnings.some((w) => /plugin-code-js-only/.test(w)))
  } finally {
    fx.cleanup()
  }
})
