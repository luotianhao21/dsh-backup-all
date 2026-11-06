/**
 * test/inventory.test.mjs — lib/inventory.js 单元测试
 *
 * 全部 fixture 造在 os.tmpdir() 下，不碰真实 $DSH_HOME；测试结束清理。
 * 覆盖：
 *   1. 完整 fixture：configFiles / bundles / plugins / patchRows(mcp+preset+普通) /
 *      skills / skillRoots / externalCandidates / excluded / warnings / 不读凭证
 *   2. opts.bundles 缺省时从 profile package.json + node_modules + installationNodeModules 兜底
 *   3. AbortSignal 提前中止
 *   4. DSH_HOME 完全不存在时降级不抛错
 *   5. maxDirBytes 截断大小统计并写 warnings
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { scanInventory } from '../lib/inventory.js'

/* ------------------------------ fixture 工具 ------------------------------ */

async function writeFile(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content)
}

async function symlink(target, linkPath) {
  await fsp.mkdir(path.dirname(linkPath), { recursive: true })
  await fsp.symlink(target, linkPath)
}

function frontmatter(name) {
  return `---\nname: ${name}\ndescription: fixture skill\n---\n\n# ${name}\n\n正文。\n`
}

const realpath = (p) => fsp.realpath(p)

/* ------------------------------ 主 fixture ------------------------------ */

async function buildMainFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-inv-main-'))
  const dshHome = path.join(root, '.dsh')
  const profileDir = path.join(dshHome, 'profiles', 'web')
  const homeDir = path.join(root, 'fake-home')
  const workspace = path.join(root, 'workspace')
  const installationNodeModules = path.join(root, 'installation', 'node_modules')
  const installationRoot = path.join(root, 'installation')

  const installBundleDir = path.join(installationNodeModules, '@deepseek-ai', 'dsh-bundle-a')
  const localPluginDir = path.join(
    dshHome,
    'dshbox',
    'dshbox-plugins',
    'local-bundle',
    'plugin',
  )

  // 安装自带 DSH 版本
  await writeFile(
    path.join(installationNodeModules, '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-fixture' }, null, 2),
  )

  // bundle A：installation 可用，补丁里有 mcp 行 + 普通行
  await writeFile(
    path.join(installBundleDir, 'package.json'),
    JSON.stringify(
      {
        name: '@deepseek-ai/dsh-bundle-a',
        version: '3.1.4',
        description: '安装自带的 fixture bundle',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2,
    ),
  )
  await writeFile(
    path.join(installBundleDir, 'cordis.patch.yml'),
    [
      '# bundle A patch',
      '- insert:',
      '    - id: mcp-server-1',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      disabled: false',
      '      config:',
      '        serverName: fixture-mcp',
      '        transport: stdio',
      '        command: node',
      '    - id: ordinary-bundle-row',
      "      name: '@deepseek-ai/dsh-timer'",
      '      config:',
      '        interval: 1000',
      '',
    ].join('\n'),
  )

  // bundle B：profile 外本地插件（file: 引用），补丁里有 preset 行 + preset registry 行
  await writeFile(
    path.join(localPluginDir, 'package.json'),
    JSON.stringify(
      {
        name: '@local/local-bundle',
        version: '1.0.0',
        description: '外部本地插件 bundle',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2,
    ),
  )
  await writeFile(
    path.join(localPluginDir, 'cordis.patch.yml'),
    [
      '# local bundle patch',
      '- insert:',
      '    - id: preset-standard-fixture',
      "      name: '@deepseek-ai/dsh-agent-preset'",
      '      config:',
      '        id: fixture-preset',
      '        name: Fixture Preset',
      '        order: 9',
      '        plugins:',
      '          - id: persona',
      "            name: '@deepseek-ai/dsh-persona'",
      '    - id: preset-registry-fixture',
      "      name: '@deepseek-ai/dsh-agent-preset-registry'",
      '      config:',
      '        directory: ./presets',
      '',
    ].join('\n'),
  )

  // profile
  await writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: {
          '@local/local-bundle': 'file:../../dshbox/dshbox-plugins/local-bundle/plugin',
          'demo-plugin': '^1.0.0',
          'broken-plugin': '^0.1.0',
        },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-bundle-a', '@local/local-bundle'],
          },
        },
      },
      null,
      2,
    ),
  )
  await writeFile(
    path.join(profileDir, 'cordis.patch.yml'),
    [
      '# fixture profile patch',
      '- id: profile-override-row',
      '  config:',
      '    welcomeNoticeVersion: 2026-09-28.1',
      '- id: preset-standard-fixture',
      '  config:',
      '    id: fixture-preset',
      '    order: 10',
      '',
    ].join('\n'),
  )
  await writeFile(path.join(profileDir, 'cordis.yml'), '[]\n')
  await writeFile(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')

  // profile node_modules：本地插件用符号链接指向 profile 外；demo/broken 是普通依赖
  await symlink(localPluginDir, path.join(profileDir, 'node_modules', '@local', 'local-bundle'))
  await writeFile(
    path.join(profileDir, 'node_modules', 'demo-plugin', 'package.json'),
    JSON.stringify({ name: 'demo-plugin', version: '2.2.2', description: '普通依赖' }, null, 2),
  )
  await writeFile(
    path.join(profileDir, 'node_modules', 'broken-plugin', 'package.json'),
    '{ this is not valid json',
  )
  await writeFile(path.join(profileDir, 'node_modules', '.cache', 'tmp.bin'), 'cache-bytes')
  await writeFile(path.join(profileDir, '.plugin-manager', 'logs', 'install.log'), 'install log')

  // $DSH_HOME 内部/外部文件
  await writeFile(
    path.join(dshHome, 'cordis.patch.yml'),
    [
      '- id: home-row',
      "  name: '@deepseek-ai/dsh-home-fixture-module'",
      '  config:',
      '    enabled: true',
      '- id: mcp-server-1',
      '  config:',
      '    serverName: fixture-mcp',
      '    transport: stdio',
      '',
    ].join('\n'),
  )
  await writeFile(
    path.join(dshHome, 'dshbox', 'plugin-guard.json'),
    JSON.stringify({ safetyMode: true }, null, 2),
  )
  await writeFile(path.join(dshHome, 'xingxi', 'pick.log'), 'xingxi data')
  await writeFile(path.join(dshHome, 'sessions', 'session-1.json'), '{"secret":true}')
  await writeFile(path.join(dshHome, 'storages', 'store-1.bin'), 'store')
  await writeFile(path.join(dshHome, '.credentials.yaml'), 'SECRET_TOKEN_XYZ: do-not-read\n')
  await writeFile(
    path.join(dshHome, '.agent-presets', 'legacy-preset', 'preset.yml'),
    'id: legacy\nname: 旧版 preset\n',
  )

  // Skills：$DSH_HOME/skills（含 .system 跳过）、~/.agents/skills、workspace 两处
  await writeFile(
    path.join(dshHome, 'skills', '.system', 'builtin-skill', 'SKILL.md'),
    frontmatter('builtin-should-be-skipped'),
  )
  await writeFile(path.join(dshHome, 'skills', 'my-skill', 'SKILL.md'), frontmatter('my-skill-front'))
  await writeFile(path.join(dshHome, 'skills', 'flat-skill.md'), frontmatter('flat-skill-front'))
  await writeFile(
    path.join(homeDir, '.agents', 'skills', 'agent-skill', 'SKILL.md'),
    frontmatter('agent-skill-front'),
  )
  await writeFile(
    path.join(workspace, '.dsh', 'skills', 'ws-skill', 'SKILL.md'),
    frontmatter('ws-skill-front'),
  )
  await writeFile(
    path.join(workspace, '.agents', 'skills', 'ws-flat.md'),
    frontmatter('ws-flat-front'),
  )

  const options = (extra = {}) => ({
    dshHome,
    profileDir,
    profileName: 'web',
    homeDir,
    installationNodeModules,
    workspaces: [{ id: 'ws-1', path: workspace, title: '测试工作区' }],
    pluginPackageName: 'dsh-backup-all',
    bundles: [
      {
        name: '@deepseek-ai/dsh-bundle-a',
        version: '3.1.4',
        description: '安装自带的 fixture bundle',
        availability: 'installation',
        source: null,
        enabled: true,
        installed: false,
        rows: [
          { rowId: 'mcp-server-1', moduleName: '@deepseek-ai/dsh-mcp-client' },
          { rowId: 'ordinary-bundle-row', moduleName: '@deepseek-ai/dsh-timer' },
        ],
        overrides: [],
        optional: false,
        removable: false,
        ...extra.bundleA,
      },
      {
        name: '@local/local-bundle',
        version: '1.0.0',
        description: '外部本地插件 bundle',
        availability: 'profile',
        source: 'file:../../dshbox/dshbox-plugins/local-bundle/plugin',
        enabled: true,
        installed: true,
        rows: [
          { rowId: 'preset-standard-fixture', moduleName: '@deepseek-ai/dsh-agent-preset' },
          { rowId: 'preset-registry-fixture', moduleName: '@deepseek-ai/dsh-agent-preset-registry' },
        ],
        overrides: [],
        optional: false,
        removable: true,
        ...extra.bundleB,
      },
    ],
    ...extra.opts,
  })

  return {
    root,
    dshHome,
    profileDir,
    homeDir,
    workspace,
    installationNodeModules,
    installationRoot,
    installBundleDir,
    localPluginDir,
    options,
  }
}

/* ------------------------------ 1. 主扫描 ------------------------------ */

test('scanInventory 完整 fixture：各字段数量与内容符合契约', async (t) => {
  const fixture = await buildMainFixture()
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))

  const inv = await scanInventory(fixture.options())

  // 元信息
  assert.equal(inv.dshHome, fixture.dshHome)
  assert.equal(inv.profileDir, fixture.profileDir)
  assert.equal(inv.profileName, 'web')
  assert.equal(inv.dshVersion, '0.2.1-fixture')
  assert.ok(!Number.isNaN(Date.parse(inv.generatedAt)), 'generatedAt 应为合法时间')

  // ---------- configFiles ----------
  assert.equal(inv.configFiles.length, 8, '7 个固定配置 + 1 个旧版 preset 文件')
  const byRole = (role) => inv.configFiles.filter((file) => file.role === role)
  const profilePackage = byRole('profile-package')[0]
  assert.equal(profilePackage.exists, true)
  assert.ok(profilePackage.bytes > 0)
  assert.match(profilePackage.sha256, /^[0-9a-f]{64}$/)
  assert.equal(byRole('profile-patch').length, 1)
  assert.equal(byRole('profile-root').length, 1)
  assert.equal(byRole('profile-lock').length, 2)
  assert.equal(byRole('home-patch')[0].exists, true)
  assert.equal(byRole('plugin-guard')[0].exists, true)
  const legacy = byRole('legacy-presets')
  assert.equal(legacy.length, 1)
  assert.ok(legacy[0].path.endsWith(path.join('.agent-presets', 'legacy-preset', 'preset.yml')))

  // ---------- bundles ----------
  assert.equal(inv.bundles.length, 2)
  const bundleA = inv.bundles.find((bundle) => bundle.name === '@deepseek-ai/dsh-bundle-a')
  const bundleB = inv.bundles.find((bundle) => bundle.name === '@local/local-bundle')
  assert.ok(bundleA && bundleB)

  assert.equal(bundleA.availability, 'installation')
  assert.equal(bundleA.enabled, true)
  assert.equal(bundleA.installed, false)
  assert.equal(bundleA.packageDir, fixture.installBundleDir)
  assert.equal(bundleA.patchFile, path.join(fixture.installBundleDir, 'cordis.patch.yml'))
  assert.ok(bundleA.packageSizeBytes > 0)
  assert.equal(bundleA.external, false)
  assert.deepEqual(bundleA.rows, [
    { rowId: 'mcp-server-1', moduleName: '@deepseek-ai/dsh-mcp-client' },
    { rowId: 'ordinary-bundle-row', moduleName: '@deepseek-ai/dsh-timer' },
  ])

  assert.equal(bundleB.availability, 'profile')
  assert.equal(bundleB.packageDir, path.join(fixture.profileDir, 'node_modules', '@local', 'local-bundle'))
  assert.ok(await realpath(bundleB.patchFile) === (await realpath(path.join(fixture.localPluginDir, 'cordis.patch.yml'))))
  assert.equal(bundleB.packageSizeBytes, 0, '符号链接目录不跟随统计')
  assert.equal(bundleB.external, true, 'file: 来源在 profile 外 → external')

  // ---------- plugins ----------
  const pluginNames = inv.plugins.map((plugin) => plugin.packageName)
  assert.deepEqual(pluginNames, ['@local/local-bundle', 'broken-plugin', 'demo-plugin'])
  const localPlugin = inv.plugins.find((plugin) => plugin.packageName === '@local/local-bundle')
  assert.equal(localPlugin.kind, 'bundle')
  assert.equal(localPlugin.externalToProfile, true)
  assert.equal(localPlugin.linkTarget, fixture.localPluginDir)
  assert.equal(localPlugin.sizeBytes, 0)
  assert.equal(localPlugin.version, '1.0.0')

  const demoPlugin = inv.plugins.find((plugin) => plugin.packageName === 'demo-plugin')
  assert.equal(demoPlugin.kind, 'dependency')
  assert.equal(demoPlugin.externalToProfile, false)
  assert.equal(demoPlugin.linkTarget, null)
  assert.equal(demoPlugin.version, '2.2.2')
  assert.ok(demoPlugin.sizeBytes > 0)

  assert.ok(inv.plugins.every((plugin) => !plugin.packageName.startsWith('.')), '不扫内部目录')

  // ---------- patchRows / mcpRows / presetRows / presetRegistryRows ----------
  // profile 补丁 2 + 首页补丁 2 + bundle A 2 + bundle B 2
  assert.equal(inv.patchRows.length, 8)
  for (const row of inv.patchRows) {
    assert.equal(typeof row.file, 'string')
    assert.equal(typeof row.id, 'string')
    assert.equal(typeof row.indent, 'number')
    assert.equal(typeof row.disabled, 'boolean')
    assert.equal(typeof row.configText, 'string')
  }
  const profileRow = inv.patchRows.find((row) => row.id === 'profile-override-row')
  assert.ok(profileRow)
  assert.equal(profileRow.name, null)
  assert.equal(profileRow.indent, 0)
  assert.match(profileRow.configText, /welcomeNoticeVersion/)
  // 按 id override 的 preset 行（不写 name）在 patchRows 里 name 为 null，但会被归入 presetRows
  const presetOverrideRow = inv.patchRows.find(
    (row) => row.id === 'preset-standard-fixture' && row.file === path.join(fixture.profileDir, 'cordis.patch.yml'),
  )
  assert.ok(presetOverrideRow)
  assert.equal(presetOverrideRow.name, null)
  assert.match(presetOverrideRow.configText, /order: 10/)

  // mcpRows = 显式插入行 + 按 id override 行（页首补丁里只写 id+config，也识别出来）
  assert.equal(inv.mcpRows.length, 2)
  const mcpInsert = inv.mcpRows.find((row) => row.file.includes('dsh-bundle-a'))
  const mcpOverride = inv.mcpRows.find(
    (row) => row.file === path.join(fixture.dshHome, 'cordis.patch.yml'),
  )
  assert.ok(mcpInsert && mcpOverride)
  assert.equal(mcpInsert.rowId, 'mcp-server-1')
  assert.equal(mcpInsert.name, '@deepseek-ai/dsh-mcp-client')
  assert.match(mcpInsert.configText, /serverName: fixture-mcp/)
  assert.match(mcpInsert.configText, /transport: stdio/)
  assert.equal(mcpOverride.rowId, 'mcp-server-1')
  assert.equal(mcpOverride.name, '@deepseek-ai/dsh-mcp-client', 'override 行回填模块名')
  assert.match(mcpOverride.configText, /serverName: fixture-mcp/)

  // presetRows = 显式插入行 + 按 id override 行
  assert.equal(inv.presetRows.length, 2)
  const presetOverride = inv.presetRows.find(
    (row) => row.file === path.join(fixture.profileDir, 'cordis.patch.yml'),
  )
  const presetInsert = inv.presetRows.find((row) => row.rowId === 'preset-standard-fixture' && row.file !== path.join(fixture.profileDir, 'cordis.patch.yml'))
  assert.ok(presetOverride && presetInsert)
  assert.equal(presetOverride.name, '@deepseek-ai/dsh-agent-preset')
  assert.match(presetOverride.configText, /order: 10/)
  assert.equal(presetInsert.name, '@deepseek-ai/dsh-agent-preset')
  assert.equal(await realpath(presetInsert.file), await realpath(path.join(fixture.localPluginDir, 'cordis.patch.yml')))
  assert.match(presetInsert.configText, /id: fixture-preset/)
  assert.match(presetInsert.configText, /name: Fixture Preset/)

  assert.equal(inv.presetRegistryRows.length, 1)
  assert.equal(inv.presetRegistryRows[0].rowId, 'preset-registry-fixture')
  assert.equal(inv.presetRegistryRows[0].name, '@deepseek-ai/dsh-agent-preset-registry')

  // ---------- skills / skillRoots ----------
  assert.equal(inv.skills.length, 5)
  const skillNames = inv.skills.map((skill) => skill.name).sort()
  assert.deepEqual(skillNames, [
    'agent-skill-front',
    'flat-skill-front',
    'my-skill-front',
    'ws-flat-front',
    'ws-skill-front',
  ])
  assert.ok(inv.skills.every((skill) => skill.external === true))
  assert.ok(inv.skills.every((skill) => skill.sizeBytes > 0))
  assert.ok(!inv.skills.some((skill) => skill.path.includes('.system')), '.system 必须跳过')
  assert.ok(!inv.skills.some((skill) => skill.name === 'builtin-should-be-skipped'))
  const flatSkill = inv.skills.find((skill) => skill.name === 'flat-skill-front')
  assert.equal(flatSkill.isDirectory, false)
  assert.ok(flatSkill.path.endsWith('flat-skill.md'))
  const dirSkill = inv.skills.find((skill) => skill.name === 'my-skill-front')
  assert.equal(dirSkill.isDirectory, true)
  assert.equal(dirSkill.source, 'user-dsh')
  assert.equal(dirSkill.root, path.join(fixture.dshHome, 'skills'))

  assert.deepEqual(
    inv.skillRoots.map((item) => ({ source: item.source, exists: item.exists, count: item.count })),
    [
      { source: 'user-dsh', exists: true, count: 2 },
      { source: 'user-agents', exists: true, count: 1 },
      { source: 'workspace-dsh', exists: true, count: 1 },
      { source: 'workspace-agents', exists: true, count: 1 },
    ],
  )

  // ---------- externalCandidates ----------
  const externalPaths = inv.externalCandidates.map((candidate) => candidate.path).sort()
  assert.deepEqual(externalPaths, [
    fixture.localPluginDir,
    path.join(fixture.dshHome, 'xingxi'),
    path.join(fixture.workspace, '.agents', 'skills'),
    path.join(fixture.workspace, '.dsh', 'skills'),
  ].sort())
  const candidateOf = (target) => inv.externalCandidates.find((candidate) => candidate.path === target)
  assert.equal(candidateOf(fixture.localPluginDir).kind, 'plugin')
  assert.equal(candidateOf(fixture.localPluginDir).why, 'local plugin link target')
  assert.equal(candidateOf(path.join(fixture.dshHome, 'xingxi')).kind, 'data')
  assert.equal(candidateOf(path.join(fixture.workspace, '.dsh', 'skills')).kind, 'skill')

  // ---------- excluded ----------
  const excludedPaths = inv.excluded.map((item) => item.path)
  assert.equal(inv.excluded.length, 6)
  for (const expected of [
    path.join(fixture.dshHome, '.credentials.yaml'),
    path.join(fixture.dshHome, 'sessions'),
    path.join(fixture.dshHome, 'storages'),
    path.join(fixture.profileDir, '.plugin-manager'),
    path.join(fixture.profileDir, 'node_modules', '.cache'),
    fixture.installationRoot,
  ]) {
    assert.ok(excludedPaths.includes(expected), `excluded 应包含 ${expected}`)
  }
  assert.ok(
    inv.excluded.find((item) => item.path.endsWith('.credentials.yaml')).why.includes('凭证'),
  )

  // ---------- warnings 与安全 ----------
  assert.ok(inv.warnings.length >= 1, '损坏的 package.json 应进 warnings')
  assert.ok(inv.warnings.some((warning) => warning.includes('broken-plugin')))
  // 不读凭证：整份清单里不能出现 secret 内容
  assert.ok(!JSON.stringify(inv).includes('SECRET_TOKEN_XYZ'), '不得读取 .credentials.yaml 内容')
})

/* ------------------------------ 2. bundles 兜底 ------------------------------ */

test('opts.bundles 缺省时用 package.json + node_modules + installationNodeModules 兜底', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-inv-fallback-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const dshHome = path.join(root, '.dsh')
  const profileDir = path.join(dshHome, 'profiles', 'web')
  const installationNodeModules = path.join(root, 'installation', 'node_modules')
  const baseBundleDir = path.join(installationNodeModules, '@deepseek-ai', 'dsh-base')

  await writeFile(
    path.join(installationNodeModules, '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-fixture' }),
  )
  await writeFile(
    path.join(baseBundleDir, 'package.json'),
    JSON.stringify({
      name: '@deepseek-ai/dsh-base',
      version: '0.2.1-rc.5',
      description: '基础 bundle',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  )
  await writeFile(
    path.join(baseBundleDir, 'cordis.patch.yml'),
    ['- insert:', '    - id: base-timer-row', "      name: '@deepseek-ai/dsh-timer'", ''].join('\n'),
  )

  await writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { 'plain-dep': '^1.0.0', 'local-b-dep': '^2.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }),
  )
  await writeFile(
    path.join(profileDir, 'node_modules', 'plain-dep', 'package.json'),
    JSON.stringify({ name: 'plain-dep', version: '1.0.0' }),
  )
  await writeFile(
    path.join(profileDir, 'node_modules', 'local-b-dep', 'package.json'),
    JSON.stringify({
      name: 'local-b-dep',
      version: '2.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
  )
  await writeFile(
    path.join(profileDir, 'node_modules', 'local-b-dep', 'cordis.patch.yml'),
    ['- insert:', '    - id: local-b-row', "      name: '@deepseek-ai/dsh-local-fixture-module'", ''].join('\n'),
  )

  const inv = await scanInventory({
    dshHome,
    profileDir,
    profileName: 'web',
    homeDir: path.join(root, 'fake-home'),
    installationNodeModules,
    // 不传 bundles：走文件兜底
  })

  assert.equal(inv.dshVersion, '0.2.1-fixture')
  assert.equal(inv.bundles.length, 2)
  const base = inv.bundles.find((bundle) => bundle.name === '@deepseek-ai/dsh-base')
  const localB = inv.bundles.find((bundle) => bundle.name === 'local-b-dep')
  assert.ok(base && localB)

  assert.equal(base.availability, 'installation')
  assert.equal(base.enabled, true)
  assert.equal(base.installed, false)
  assert.equal(base.packageDir, baseBundleDir)
  assert.equal(base.patchFile, path.join(baseBundleDir, 'cordis.patch.yml'))
  assert.equal(base.packageSizeBytes > 0, true)
  assert.equal(base.external, false)
  assert.deepEqual(base.rows, [{ rowId: 'base-timer-row', moduleName: '@deepseek-ai/dsh-timer' }])

  assert.equal(localB.availability, 'profile')
  assert.equal(localB.enabled, false, '依赖里有 bundle patch 但未在 dsh.profile.bundles 中启用')
  assert.equal(localB.installed, true)
  assert.deepEqual(localB.rows, [
    { rowId: 'local-b-row', moduleName: '@deepseek-ai/dsh-local-fixture-module' },
  ])

  // 普通依赖只进 plugins，不当 bundle
  assert.ok(inv.plugins.some((plugin) => plugin.packageName === 'plain-dep'))
  assert.ok(!inv.bundles.some((bundle) => bundle.name === 'plain-dep'))

  // 兜底路径同样完成补丁行扫描
  assert.equal(inv.patchRows.length, 2)
  assert.equal(inv.mcpRows.length, 0)
})

/* ------------------------------ 3. AbortSignal ------------------------------ */

test('AbortSignal 已中止时抛 AbortError', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-inv-abort-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const dshHome = path.join(root, '.dsh')
  const profileDir = path.join(dshHome, 'profiles', 'web')
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p' }))

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () =>
      scanInventory({
        dshHome,
        profileDir,
        profileName: 'web',
        homeDir: path.join(root, 'fake-home'),
        signal: controller.signal,
      }),
    (err) => err.name === 'AbortError',
  )
})

/* ------------------------------ 4. 路径不存在降级 ------------------------------ */

test('DSH_HOME / profile 不存在时不抛错，字段为空并有 exists=false 的配置项', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-inv-empty-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))

  const inv = await scanInventory({
    dshHome: path.join(root, 'no-dsh-home'),
    profileDir: path.join(root, 'no-dsh-home', 'profiles', 'web'),
    profileName: 'web',
    homeDir: path.join(root, 'fake-home'),
  })

  assert.equal(inv.dshVersion, null)
  assert.equal(inv.bundles.length, 0)
  assert.equal(inv.plugins.length, 0)
  assert.equal(inv.skills.length, 0)
  assert.equal(inv.patchRows.length, 0)
  assert.equal(inv.externalCandidates.length, 0)
  assert.ok(inv.configFiles.length >= 7)
  assert.ok(inv.configFiles.every((file) => file.exists === false))
  assert.equal(inv.skillRoots.length, 2)
  assert.ok(inv.skillRoots.every((root) => root.exists === false))
})

/* ------------------------------ 5. maxDirBytes ------------------------------ */

test('maxDirBytes 截断目录大小统计并写入 size-capped warning', async (t) => {
  const fixture = await buildMainFixture()
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }))

  const maxDirBytes = 16
  const inv = await scanInventory(fixture.options({ opts: { maxDirBytes } }))

  assert.ok(inv.warnings.some((warning) => warning.includes('size-capped')))
  assert.ok(
    inv.plugins.every((plugin) => plugin.sizeBytes <= maxDirBytes),
    '插件大小不得超过上限',
  )
  assert.ok(
    inv.bundles.every((bundle) => bundle.packageSizeBytes <= maxDirBytes),
    'bundle 大小不得超过上限',
  )
  assert.ok(
    inv.skills.every((skill) => skill.sizeBytes <= maxDirBytes),
    'skill 大小不得超过上限',
  )
})
