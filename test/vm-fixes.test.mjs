// 远程 VM 跨机测试暴露的 4 个 bug + 2 个风险的回归测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { renderRestoreDoc } from '../lib/restore-doc.js'
import { resolveRestoreTarget } from '../lib/paths.js'
import { createRestoreTools } from '../lib/tools-restore.js'
import { resolveEnv } from '../lib/paths.js'

function fixtureEnv() {
  const base = join(tmpdir(), 'dsh-ba-vmfix-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  const dshHome = join(base, 'home')
  const profileDir = join(dshHome, 'profiles', 'web')
  const workspace = join(base, 'ws')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const env = resolveEnv({ dshHome, profileName: 'web', profileDir, homeDir: join(base, 'user'), backupDir: join(base, 'backup'), dataDir: join(base, 'data') })
  return { base, env, profileDir, workspace, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('BUG.docBundleCmd/docBareRange：RESTORE.md 9.3 不再生成 registry 风格的本地插件命令或缺包名范围', () => {
  const { base, env, cleanup } = fixtureEnv()
  try {
    const manifest = {
      createdAt: '2026-11-06T00:00:00.000Z',
      environment: { dshHome: env.dshHome, profileName: 'web', profileDir: env.profileDir, platform: 'linux', nodeVersion: 'v24' },
      workspaces: [],
      snapshotPolicy: { packPluginCode: 'local-only', excludeCredentials: false, credentialsIncluded: true },
      credentialsIncluded: true,
      bundles: [
        { name: 'mem-kit', version: '0.3.1', availability: 'profile', external: true, source: 'file:../../dshbox/dshbox-plugins/mem-kit/plugin', rows: [] },
        { name: 'registry-demo', version: '1.2.3', availability: 'profile', external: false, source: '^1.2.3', rows: [] },
      ],
      plugins: [
        {
          name: 'mem-kit', version: '0.3.1', external: true, packed: true, redownloadable: false,
          spec: 'file:../../dshbox/dshbox-plugins/mem-kit/plugin',
          linkTarget: '/old-machine/dshbox/dshbox-plugins/mem-kit/plugin',
          codeTarget: '$DSH_HOME/dshbox/dshbox-plugins/mem-kit/plugin',
          codeArchivePath: 'files/0006_plugin',
        },
        { name: 'registry-demo', version: '1.2.3', external: false, packed: false, redownloadable: true, spec: '^1.2.3' },
      ],
      entries: [],
      configFiles: [],
      mcpRows: [],
      presetRows: [],
      excluded: [],
      warnings: [],
    }
    const doc = renderRestoreDoc({ record: { name: 'vm-fix', createdAt: manifest.createdAt }, manifest, plan: null, aiDoc: '' })
    // 不能出现 registry 风格的本地插件命令
    assert.ok(!/add mem-kit@0\.3\.1/.test(doc), '本地插件不能生成 add mem-kit@0.3.1')
    // 不能出现缺包名的范围
    assert.ok(!/add \^1\.2\.3/.test(doc), '不能生成 add ^1.2.3')
    // 范围命令必须带包名
    assert.ok(/add registry-demo@\^1\.2\.3/.test(doc), '范围 spec 应拼成 name@range')
    // 已入包插件恢复方式指向 codeTarget，而不是旧机 linkTarget
    assert.ok(doc.includes('$DSH_HOME/dshbox/dshbox-plugins/mem-kit/plugin'), '恢复方式应引用 codeTarget')
    assert.ok(!doc.includes('/old-machine/dshbox/dshbox-plugins/mem-kit/plugin)'), '恢复方式不应把旧机绝对路径当恢复目标')
    // 9.3 中本地插件命令应为 file: 形式（而非 registry）
    assert.ok(/add file:/.test(doc) || doc.includes('解出到'), '应提供 file: / 解出命令')
  } finally {
    cleanup()
  }
})

test('BUG.comparePluginsPresent：packed 插件的 present 由 codeTarget 重映射后是否存在判断', async () => {
  const { base, env, workspace, cleanup } = fixtureEnv()
  try {
    // 当前机器上 codeTarget 解出的目录存在（模拟 B 机恢复后）
    const codeDir = join(env.dshHome, 'dshbox', 'dshbox-plugins', 'mem-kit', 'plugin')
    mkdirSync(codeDir, { recursive: true })
    writeFileSync(join(codeDir, 'index.js'), 'export {}\n', 'utf8')
    const manifest = {
      environment: { dshHome: '/old-machine/.dsh', profileDir: '/old-machine/.dsh/profiles/web', homeDir: '/old-machine' },
      workspaces: [],
      entries: [],
      plugins: [
        { name: 'mem-kit', version: '0.3.1', packageDir: '/old-machine/.dsh/dshbox/dshbox-plugins/mem-kit/plugin', packed: true, codeTarget: '$DSH_HOME/dshbox/dshbox-plugins/mem-kit/plugin', redownloadable: false },
        { name: 'registry-demo', version: '1.2.3', packageDir: '/old-machine/.dsh/profiles/web/node_modules/registry-demo', packed: false },
      ],
    }
    const tools = createRestoreTools({
      env, extractedDir: join(base, 'extracted'), manifest, plan: null, restoreDoc: '',
      workspaces: [{ id: 'w', name: 'ws', path: workspace }],
      setProgress: () => {}, log: () => {}, setFinished: () => {},
      safetyDir: join(base, 'safety'),
    })
    const compareTool = tools.tools.find((tool) => tool.name === 'restore_compare')
    const result = JSON.parse(await compareTool.execute({}))
    const memKit = result.plugins.find((p) => p.name === 'mem-kit')
    const registryDemo = result.plugins.find((p) => p.name === 'registry-demo')
    assert.equal(memKit.present, true, 'codeTarget 已存在的 packed 插件应 present=true（不能再用旧机 packageDir 判断）')
    assert.equal(registryDemo.present, false, '未安装的 registry 插件应 present=false')
  } finally {
    cleanup()
  }
})

test('RISK.fallbackCollision：不同外部路径同名时 fallback 目标不冲突', () => {
  const { env, workspace, cleanup } = fixtureEnv()
  try {
    const oldEnv = { dshHome: '/old/.dsh', profileDir: '/old/.dsh/profiles/web', homeDir: '/old' }
    const workspaces = [{ id: 'w', name: 'ws', path: workspace }]
    const a = resolveRestoreTarget({ target: '/opt/toolA/tool-data', source: '/opt/toolA/tool-data' }, oldEnv, env, workspaces)
    const b = resolveRestoreTarget({ target: '/opt/toolB/tool-data', source: '/opt/toolB/tool-data' }, oldEnv, env, workspaces)
    assert.equal(a.mode, 'fallback')
    assert.equal(b.mode, 'fallback')
    assert.notEqual(a.target, b.target, '同名不同路径的 fallback 目标必须不同，避免静默覆盖')
  } finally {
    cleanup()
  }
})

test('RISK.policyNoExcludeField：manifest.snapshotPolicy 含 excludeCredentials 与 credentialsFilePresent', async () => {
  const { base, env, profileDir, cleanup } = fixtureEnv()
  try {
    // 最小 fixture 使 collect.build 能跑通
    writeFileSync(join(env.dshHome, '.credentials.yaml'), 'version: 1\n', 'utf8')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf8')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
    writeFileSync(join(profileDir, 'cordis.yml'), '[]\n', 'utf8')
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    const { createCollector } = await import('../lib/collect.js')
    const inventory = { configFiles: [], skills: [], plugins: [], externalCandidates: [], excluded: [], warnings: [], dshVersion: null }
    const staging = join(base, 'staging')
    mkdirSync(staging, { recursive: true })
    const collector = createCollector({ env, inventory, workspaces: [], stagingDir: staging, log: () => {}, options: { packPluginCode: 'local-only', excludeCredentials: true } })
    const built = await collector.build({ snapshot: { name: 'policy', description: '' } })
    assert.equal(built.manifest.snapshotPolicy.excludeCredentials, true)
    assert.equal(built.manifest.snapshotPolicy.credentialsIncluded, false)
    assert.equal(built.manifest.snapshotPolicy.credentialsFilePresent, true)
  } finally {
    cleanup()
  }
})
