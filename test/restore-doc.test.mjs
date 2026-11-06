/**
 * test/restore-doc.test.mjs —— 验证 RESTORE.md / INVENTORY.md 渲染器与提示词装配。
 *
 * 覆盖：
 * 1. renderRestoreDoc：固定小节、路径对照、插件重装、MCP/Preset、外部文件、回滚、自检清单、凭据提醒；
 * 2. renderRestoreDoc：无 aiDoc 兜底、空输入容错、AI 正文标题降级、密钥不泄漏；
 * 3. renderInventoryDoc：中文表格、各清单区块、空 manifest 容错、直接传 inventory；
 * 4. prompts：两份系统提示词包含全部工具名与关键语义；两个用户提示词注入关键信息但不泄漏密钥、长度受控。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderRestoreDoc, renderInventoryDoc } from '../lib/restore-doc.js';
import {
  SNAPSHOT_SYSTEM_PROMPT,
  RESTORE_SYSTEM_PROMPT,
  INTERRUPT_INSTRUCTION,
  renderSnapshotUserPrompt,
  renderRestoreUserPrompt,
} from '../lib/prompts.js';

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const PROFILE_DIR = '/root/projects/.dsh/profiles/web';
const DSH_HOME = '/root/projects/.dsh';
const LONG_SHA = 'abcdef0123456789'.repeat(4);

function makeManifest() {
  return {
    name: '测试快照',
    description: '给测试用的快照',
    createdAt: '2026-11-05T12:45:12.000Z',
    kind: 'snapshot',
    environment: {
      dshVersion: '0.2.1-rc.5',
      dshHome: DSH_HOME,
      profileName: 'web',
      profileDir: PROFILE_DIR,
      platform: 'linux',
      nodeVersion: 'v24.19.0',
    },
    archive: {
      file: '2026-11-05 20-45-12.backup.tar.br',
      bytes: 1200 * 1024,
      rawBytes: 4 * 1024 * 1024,
      ratio: 0.3,
    },
    inventory: {
      generatedAt: '2026-11-05T12:45:00.000Z',
      dshHome: DSH_HOME,
      profileName: 'web',
      profileDir: PROFILE_DIR,
      dshVersion: '0.2.1-rc.5',
      configFiles: [
        { path: `${PROFILE_DIR}/package.json`, role: 'profile-package', exists: true, bytes: 512, sha256: LONG_SHA },
        { path: `${PROFILE_DIR}/cordis.patch.yml`, role: 'profile-patch', exists: true, bytes: 900, sha256: 'b'.repeat(64) },
        { path: `${DSH_HOME}/cordis.patch.yml`, role: 'home-patch', exists: false },
        { path: `${DSH_HOME}/.credentials.yaml`, role: 'credentials', exists: true, bytes: 128, sha256: 'c'.repeat(64) },
      ],
      bundles: [
        { name: 'dsh-demo', version: '1.2.3', availability: 'profile', enabled: true, rows: [{ rowId: 'demo-row' }] },
        { name: 'dsh-mcp-client', version: '0.2.1-rc.5', availability: 'installation', enabled: true, rows: [] },
      ],
      plugins: [
        {
          packageName: 'dsh-local',
          version: '0.1.0',
          kind: 'local-plugin',
          linkTarget: `${DSH_HOME}/dshbox/dshbox-plugins/demo/plugin`,
          externalToProfile: true,
        },
        { packageName: 'dsh-dep', version: '2.0.0', kind: 'dependency', externalToProfile: false },
      ],
      patchRows: [
        { file: `${PROFILE_DIR}/cordis.patch.yml`, id: 'demo-row', name: 'dsh-demo', disabled: false, indent: 4 },
      ],
      mcpRows: [
        {
          file: `${PROFILE_DIR}/cordis.patch.yml`,
          rowId: 'mcp-fs',
          name: '@deepseek-ai/dsh-mcp-client',
          configText: 'serverName: fs\ntransport: stdio\ncommand: /root/projects/.dsh/mcp/fs.mjs\ntoken: supersecret-token',
        },
      ],
      presetRows: [
        {
          file: `${PROFILE_DIR}/cordis.patch.yml`,
          rowId: 'preset-main',
          name: '@deepseek-ai/dsh-agent-preset',
          configText: 'id: my-preset\nname: 我的预设',
        },
      ],
      presetRegistryRows: [
        { file: `${PROFILE_DIR}/cordis.patch.yml`, rowId: 'registry-row', name: '@deepseek-ai/dsh-agent-preset-registry' },
      ],
      skills: [
        { name: 'my-skill', path: `${DSH_HOME}/skills/my-skill`, root: `${DSH_HOME}/skills`, source: 'user-dsh', external: true },
      ],
      skillRoots: [{ path: `${DSH_HOME}/skills`, source: 'user-dsh', exists: true, count: 1 }],
      externalCandidates: [
        { path: `${DSH_HOME}/xingxi`, why: '插件数据目录（dsh-xingxi 记忆档案）', kind: 'data' },
        { path: '/root/projects/.dsh/mcp', why: 'MCP server 脚本目录', kind: 'mcp' },
      ],
      excluded: [{ path: `${DSH_HOME}/sessions`, why: 'DSH 会话数据' }],
      warnings: ['size-capped: /root/projects/.dsh/xingxi（超过统计上限）'],
    },
    plugins: [
      {
        packageName: 'dsh-local',
        version: '0.1.0',
        kind: 'local-plugin',
        spec: 'file:/root/projects/.dsh/dshbox/dshbox-plugins/demo/plugin',
        linkTarget: '/root/projects/.dsh/dshbox/dshbox-plugins/demo/plugin',
      },
      { packageName: 'dsh-dep', version: '2.0.0', kind: 'dependency', spec: 'dsh-dep@2.0.0' },
    ],
    files: [
      {
        kind: 'config',
        source: `${PROFILE_DIR}/package.json`,
        archivePath: 'files/1_package.json',
        target: `${PROFILE_DIR}/package.json`,
        note: '覆盖恢复',
        sha256: LONG_SHA,
      },
      {
        kind: 'config',
        source: `${PROFILE_DIR}/cordis.patch.yml`,
        archivePath: 'files/2_cordis.patch.yml',
        target: `${PROFILE_DIR}/cordis.patch.yml`,
        note: '覆盖恢复',
      },
      {
        kind: 'data',
        source: `${DSH_HOME}/xingxi`,
        archivePath: 'files/3_xingxi',
        target: `${DSH_HOME}/xingxi`,
        why: '插件数据目录，运行时读取',
        note: '整目录恢复',
      },
      {
        kind: 'skill',
        source: `${DSH_HOME}/skills/my-skill`,
        archivePath: 'files/4_my-skill',
        target: `${DSH_HOME}/skills/my-skill`,
        why: '用户自定义 Skill',
      },
    ],
    excluded: [{ path: `${DSH_HOME}/storages`, why: '存储数据' }],
  };
}

const PLAN = {
  environment: { dshVersion: '0.2.1-rc.5', profileName: 'web' },
  items: [
    { kind: 'config', source: 'files/1_package.json', target: `${PROFILE_DIR}/package.json`, note: '覆盖恢复' },
    { kind: 'data', source: 'files/3_xingxi', target: `${DSH_HOME}/xingxi`, note: '整目录放回' },
  ],
  steps: ['恢复配置文件', '恢复外部文件', '按 manifest 重装插件', '重启 DSH'],
  restartRequired: true,
  rollback: '恢复前快照（pre-restore）',
};

const RECORD = { name: '测试快照', description: '给测试用的快照', createdAt: '2026-11-05T12:45:12.000Z', kind: 'snapshot', file: '2026-11-05 20-45-12.backup.tar.br' };

function renderFullDoc(overrides = {}) {
  const manifest = makeManifest();
  return renderRestoreDoc({
    record: RECORD,
    manifest,
    plan: PLAN,
    environment: manifest.environment,
    aiDoc: '# AI 撰写的关键提示\n\n这是一段 AI 正文。',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// renderRestoreDoc
// ---------------------------------------------------------------------------

test('renderRestoreDoc 包含全部必需小节与关键内容', () => {
  const doc = renderFullDoc();

  // 固定小节（契约 C 节 + Lead 补充的“内容边界/安全警告”）
  for (const heading of [
    '# DSH 环境恢复说明',
    '## 1. 快照元信息',
    '## 2. 安全警告与凭据处理',
    '## 3. 环境要求',
    '## 4. 快照内容边界',
    '## 5. 快照说明',
    '## 6. 恢复步骤',
    '## 7. 路径对照表',
    '## 8. 配置文件说明',
    '## 9. 插件清单与重装命令',
    '## 10. MCP / Agent Preset 行恢复说明',
    '## 11. 外部文件对照表',
    '## 12. 校验方式',
    '## 13. 失败回滚',
    '## 14. 恢复后自检清单',
    '## 15. 附录',
  ]) {
    assert.ok(doc.includes(heading), `缺少小节：${heading}`);
  }

  // 元信息 / 环境
  assert.ok(doc.includes('测试快照'));
  assert.ok(doc.includes('给测试用的快照'));
  assert.ok(doc.includes('2026-11-05 20-45-12.backup.tar.br'));
  assert.ok(doc.includes('/root/projects/.dsh/profiles/web'));
  assert.ok(doc.includes('0.2.1-rc.5'));

  // 压缩格式与文件名规则
  assert.ok(doc.includes('.backup.tar.br'));
  assert.ok(doc.includes('Brotli'));

  // 凭据：显著提醒 + 只出现路径、不出现内容
  assert.ok(doc.includes('明文'));
  assert.ok(doc.includes('.credentials.yaml'));
  assert.ok(doc.includes('轮换'));

  // 插件代码本体不在包里 + 重装命令 + file: 本地插件
  assert.ok(doc.includes('插件 / registry 包代码本体') || doc.includes('插件代码本体'));
  assert.ok(doc.includes('不在快照包内') || doc.includes('不在包内'));
  assert.ok(doc.includes('dsh plugin --profile web add dsh-demo@1.2.3'));
  assert.ok(doc.includes('dsh plugin --profile web add file:/root/projects/.dsh/dshbox/dshbox-plugins/demo/plugin'));
  assert.ok(doc.includes('pnpm install --frozen-lockfile'));

  // 路径对照表内容
  assert.ok(doc.includes('files/1_package.json'));
  assert.ok(doc.includes('files/3_xingxi'));
  assert.ok(doc.includes('/root/projects/.dsh/xingxi'));
  assert.ok(doc.includes('abcdef0123456789…'), 'sha256 前 16 位应出现在路径对照表');

  // 外部文件表 + 判定理由
  assert.ok(doc.includes('插件数据目录，运行时读取'));
  assert.ok(doc.includes('用户自定义 Skill'));

  // MCP / Preset 行
  assert.ok(doc.includes('@deepseek-ai/dsh-mcp-client'));
  assert.ok(doc.includes('@deepseek-ai/dsh-agent-preset'));
  assert.ok(doc.includes('mcp-fs'));
  assert.ok(doc.includes('preset-main'));

  // 重启 / 回滚 / 自检
  assert.ok(doc.includes('重启 DSH'));
  assert.ok(doc.includes('只刷新浏览器页面不够'));
  assert.ok(doc.includes('恢复前快照'));
  assert.ok(doc.includes('- [ ]'));

  // AI 正文与计划摘要
  assert.ok(doc.includes('### AI 撰写的关键提示'), 'AI 正文的一级标题应降级为 ###');
  assert.ok(!doc.includes('\n# AI 撰写的关键提示'), '不应保留一级标题');
  assert.ok(doc.includes('这是一段 AI 正文。'));
  assert.ok(doc.includes('需要重启 DSH'));
  assert.ok(doc.includes('恢复配置文件'));

  // Markdown 表格
  assert.ok(doc.includes('| --- |'));
});

test('renderRestoreDoc 不泄漏 MCP 配置中的密钥', () => {
  const doc = renderFullDoc();
  assert.ok(!doc.includes('supersecret-token'), 'MCP 行配置原文必须脱敏');
  assert.ok(doc.includes('（已省略）'), '脱敏位置应标注已省略');
  // 但配置里的非敏感字段仍应保留，便于手工重填
  assert.ok(doc.includes('serverName: fs'));
});

test('renderRestoreDoc 无 aiDoc 时给出兜底正文', () => {
  const manifest = makeManifest();
  const doc = renderRestoreDoc({ record: RECORD, manifest, plan: PLAN });
  assert.ok(doc.includes('未撰写额外恢复说明'));
  assert.ok(doc.includes('INVENTORY.md'));
  // 无 plan 时不应出现计划摘要小节
  const noPlanDoc = renderRestoreDoc({ record: RECORD, manifest });
  assert.ok(noPlanDoc.includes('## 1. 快照元信息'));
  assert.ok(!noPlanDoc.includes('5.1 结构化恢复计划摘要'));
});

test('renderRestoreDoc 对空输入与残缺 manifest 容错', () => {
  const doc = renderRestoreDoc();
  assert.equal(typeof doc, 'string');
  assert.ok(doc.length > 1000);
  assert.ok(doc.includes('# DSH 环境恢复说明'));
  assert.ok(doc.includes('未命名快照'));
  assert.ok(doc.includes('（未记录）'));

  const sparse = renderRestoreDoc({ manifest: { inventory: {} } });
  assert.ok(sparse.includes('## 15. 附录'));

  // 空 configFiles 时按标准 profile 结构给出兜底表
  assert.ok(sparse.includes('package.json'));
  assert.ok(sparse.includes('cordis.patch.yml'));
});

test('renderRestoreDoc 对 pre-restore 快照标注类型', () => {
  const doc = renderRestoreDoc({ record: { name: '恢复前快照', kind: 'pre-restore' }, manifest: makeManifest() });
  assert.ok(doc.includes('恢复前快照（pre-restore）'));
});

// ---------------------------------------------------------------------------
// renderInventoryDoc
// ---------------------------------------------------------------------------

test('renderInventoryDoc 渲染中文清单表格', () => {
  const doc = renderInventoryDoc(makeManifest());

  assert.ok(doc.includes('# DSH 环境清单'));
  assert.ok(doc.includes('## 1. 基本信息'));
  assert.ok(doc.includes('## 2. 配置文件清单'));
  assert.ok(doc.includes('## 3. 插件包（bundles）'));
  assert.ok(doc.includes('## 4. profile 依赖与本地插件'));
  assert.ok(doc.includes('## 5. Skill'));
  assert.ok(doc.includes('## 6. Skill 根目录'));
  assert.ok(doc.includes('## 7. 补丁行（cordis.patch.yml）'));
  assert.ok(doc.includes('## 8. MCP 行'));
  assert.ok(doc.includes('## 9. Agent Preset 行'));
  assert.ok(doc.includes('## 10. Preset Registry 行'));
  assert.ok(doc.includes('## 11. 外部文件候选'));
  assert.ok(doc.includes('## 12. 快照文件条目'));
  assert.ok(doc.includes('## 13. 排除项'));
  assert.ok(doc.includes('## 14. 扫描警告'));
  assert.ok(doc.includes('## 15. 快照包结构'));

  // 关键数据行
  assert.ok(doc.includes('dsh-demo'));
  assert.ok(doc.includes('1.2.3'));
  assert.ok(doc.includes('my-skill'));
  assert.ok(doc.includes('/root/projects/.dsh/skills'));
  assert.ok(doc.includes('demo-row'));
  assert.ok(doc.includes('mcp-fs'));
  assert.ok(doc.includes('preset-main'));
  assert.ok(doc.includes('/root/projects/.dsh/xingxi'));
  assert.ok(doc.includes('/root/projects/.dsh/sessions'));
  assert.ok(doc.includes('size-capped'));
  assert.ok(doc.includes('files/3_xingxi'));
  assert.ok(doc.includes('| --- |'));
  // 凭据只出现路径，不出现内容
  assert.ok(doc.includes('.credentials.yaml'));
  assert.ok(!doc.includes('supersecret-token'));
});

test('renderInventoryDoc 容错空输入与直接传 inventory', () => {
  const empty = renderInventoryDoc();
  assert.equal(typeof empty, 'string');
  assert.ok(empty.includes('# DSH 环境清单'));
  assert.ok(empty.includes('（无）'));

  const inventoryOnly = renderInventoryDoc(makeManifest().inventory);
  assert.ok(inventoryOnly.includes('web'));
  assert.ok(inventoryOnly.includes('/root/projects/.dsh/profiles/web'));
  assert.ok(inventoryOnly.includes('dsh-demo'));
});

// ---------------------------------------------------------------------------
// 真实 collect.js manifest 形态（entries + 编码 target + 凭据 + notPacked）
// ---------------------------------------------------------------------------

function makeCollectManifest() {
  const to = (target, extra = {}) => ({ ...extra, target });
  return {
    formatVersion: 1,
    generator: 'dsh-backup-all',
    createdAt: '2026-11-05T12:45:12.000Z',
    snapshot: { name: '真实形态快照', description: 'collect.js 产出的 manifest', kind: 'snapshot' },
    environment: {
      dshHome: DSH_HOME,
      profileName: 'web',
      profileDir: PROFILE_DIR,
      homeDir: '/root',
      platform: 'linux',
      nodeVersion: 'v24.19.0',
      dshVersion: '0.2.1-rc.5',
    },
    workspaces: [{ id: 'w1', name: 'demo-ws', path: '/root/projects/demo-ws' }],
    configFiles: [
      { path: `${PROFILE_DIR}/package.json`, role: 'profile-package', exists: true, bytes: 512, sha256: LONG_SHA },
      { path: `${PROFILE_DIR}/cordis.patch.yml`, role: 'profile-patch', exists: true, bytes: 900 },
    ],
    plugins: [
      {
        name: 'dsh-local',
        version: '0.1.0',
        packageDir: `${PROFILE_DIR}/node_modules/dsh-local`,
        external: true,
        linkTarget: '/root/projects/my-plugin',
        bundled: false,
        source: '',
        bundle: false,
        rows: [],
        restoreHint: '本地 file: 插件：恢复时原始目录必须存在',
      },
      { name: 'dsh-demo', version: '1.2.3', packageDir: '', external: false, linkTarget: '', bundled: false, source: '', bundle: true, rows: [{ rowId: 'demo' }] },
    ],
    bundles: [
      { name: 'dsh-demo', version: '1.2.3', availability: 'profile', enabled: true, rows: [{ rowId: 'demo' }] },
    ],
    skills: [{ name: 'ws-skill', path: '/root/projects/demo-ws/.dsh/skills/ws-skill', root: '/root/projects/demo-ws/.dsh/skills', source: 'workspace-dsh', external: true }],
    patchRows: [{ file: `${PROFILE_DIR}/cordis.patch.yml`, id: 'demo', name: 'dsh-demo', disabled: false }],
    mcpRows: [{ file: `${PROFILE_DIR}/cordis.patch.yml`, rowId: 'mcp-fs', name: '@deepseek-ai/dsh-mcp-client' }],
    presetRows: [],
    presetRegistryRows: [],
    entries: [
      {
        kind: 'config',
        source: `${PROFILE_DIR}/package.json`,
        target: '$DSH_PROFILE_DIR/package.json',
        why: 'DSH 配置文件',
        note: '',
        archivePath: 'files/0001_package.json',
        isDirectory: false,
        bytes: 512,
        files: 1,
        sha256: LONG_SHA,
      },
      {
        kind: 'credentials',
        source: `${DSH_HOME}/.credentials.yaml`,
        target: '$DSH_HOME/.credentials.yaml',
        why: 'DSH 凭据文件（含 API Key/token，用户选择打包）',
        note: '',
        archivePath: 'files/0002_.credentials.yaml',
        isDirectory: false,
        bytes: 128,
        files: 1,
        sha256: '',
      },
      {
        kind: 'plugin-data',
        source: `${DSH_HOME}/xingxi`,
        target: '$DSH_HOME/xingxi',
        why: '插件数据目录',
        note: '整目录恢复',
        archivePath: 'files/0003_xingxi',
        isDirectory: true,
        bytes: 1024,
        files: 3,
        sha256: '',
      },
      {
        kind: 'skill',
        source: '/root/projects/demo-ws/.dsh/skills/ws-skill',
        target: '$WORKSPACE:demo-ws/.dsh/skills/ws-skill',
        why: '工作区 Skill',
        note: '',
        archivePath: 'files/0004_ws-skill',
        isDirectory: true,
        bytes: 256,
        files: 1,
        sha256: '',
      },
      {
        kind: 'external',
        source: '/root/projects/unknown-dir',
        target: '$WORKSPACE:missing-ws/unknown-dir',
        why: '未匹配工作区',
        note: '',
        archivePath: 'files/0005_unknown-dir',
        isDirectory: true,
        bytes: 64,
        files: 1,
        sha256: '',
      },
    ],
    excluded: [{ path: `${DSH_HOME}/sessions`, why: 'DSH 会话数据' }],
    warnings: [],
    credentialsIncluded: true,
    notPacked: [{ kind: 'plugin-code', path: `${PROFILE_DIR}/node_modules/dsh-local`, why: '插件代码本体不打包（用户选择“只打包配置与来源记录”）' }],
  };
}

test('renderRestoreDoc 兼容 collect.js 实际 manifest：解码 target、凭据、notPacked、工作区映射', () => {
  const manifest = makeCollectManifest();
  const doc = renderRestoreDoc({
    record: { name: '真实形态快照', description: 'collect.js 产出的 manifest', createdAt: manifest.createdAt },
    manifest,
    plan: {
      steps: [
        { id: 'restore-files', title: '放回配置文件与外部文件', description: '按 manifest.entries 恢复' },
        { id: 'reinstall-plugins', title: '重新安装插件', description: '按 manifest.plugins 重装' },
        { id: 'restart', title: '重启 DSH', description: '插件与配置变更需要重启后生效' },
      ],
    },
    aiDoc: '',
    environment: manifest.environment,
  });

  // 记录值（编码目标串）与当前机器解码路径同时出现
  assert.ok(doc.includes('$DSH_PROFILE_DIR/package.json'), '应展示编码目标串');
  assert.ok(doc.includes(`${PROFILE_DIR}/package.json`), '应解码出当前机器路径');
  assert.ok(doc.includes(`${DSH_HOME}/xingxi`));
  assert.ok(doc.includes('/root/projects/demo-ws/.dsh/skills/ws-skill'), '应解码 $WORKSPACE 目标');
  assert.ok(doc.includes('需人工映射'), '无法匹配的 $WORKSPACE 目标应提示人工映射');

  // 凭据：只给路径 + 明文警告，不展开内容
  assert.ok(doc.includes('.credentials.yaml'));
  assert.ok(doc.includes('明文'));
  assert.ok(doc.includes('轮换'));

  // notPacked 与插件重装
  assert.ok(doc.includes('插件代码本体不打包'));
  assert.ok(doc.includes('dsh plugin --profile web add'));

  // 计划步骤（对象形态）
  assert.ok(doc.includes('放回配置文件与外部文件'));
  assert.ok(doc.includes('重新安装插件'));
  assert.ok(doc.includes('重启 DSH'));

  // 条目类型使用工具真实 kind
  assert.ok(doc.includes('插件数据'));
  assert.ok(!/^##\s+Restore/m.test(doc), '不应输出英文小节标题');
});

test('renderInventoryDoc 兼容 collect.js 实际 manifest（snapshot 元信息 + entries）', () => {
  const doc = renderInventoryDoc(makeCollectManifest());
  assert.ok(doc.includes('真实形态快照'), '应从 manifest.snapshot 取快照名');
  assert.ok(doc.includes('collect.js 产出的 manifest'));
  assert.ok(doc.includes('$DSH_PROFILE_DIR/package.json') || doc.includes(`${PROFILE_DIR}/package.json`));
  assert.ok(doc.includes(`${PROFILE_DIR}/package.json`));
  assert.ok(doc.includes(`${DSH_HOME}/xingxi`));
  assert.ok(doc.includes('plugin-data') === false); // 表格里显示中文类型
  assert.ok(doc.includes('插件数据'));
  assert.ok(!doc.includes('supersecret'));
});

test('renderSnapshotUserPrompt 兼容 tools-snapshot 的 inventorySummary 摘要形态', () => {
  const inventorySummary = {
    profileName: 'web',
    dshHome: DSH_HOME,
    profileDir: PROFILE_DIR,
    configFiles: [{ path: `${PROFILE_DIR}/package.json`, role: 'profile-package', exists: true, bytes: 512 }],
    counts: {
      bundles: 2,
      enabledBundles: 2,
      plugins: 1,
      skills: 1,
      patchRows: 3,
      mcpRows: 1,
      presetRows: 0,
      externalCandidates: 2,
    },
    skills: [{ name: 'my-skill', path: `${DSH_HOME}/skills/my-skill`, root: `${DSH_HOME}/skills`, source: 'user-dsh' }],
  };
  const prompt = renderSnapshotUserPrompt({
    snapshotName: '摘要形态',
    description: '',
    inventory: inventorySummary,
    config: {
      version: '1.0.0',
      dshHome: DSH_HOME,
      profileName: 'web',
      profileDir: PROFILE_DIR,
      pluginRoot: '/root/projects/DSH Backup ALL',
      backupDir: '/root/projects/DSH Backup ALL/backup',
      workspaces: [{ id: 'w1', name: 'demo-ws', path: '/root/projects/demo-ws' }],
      credentialsIncluded: true,
      pluginCodeIncluded: false,
    },
  });
  assert.ok(prompt.includes('摘要形态'));
  assert.ok(prompt.includes('externalCandidates'));
  assert.ok(prompt.includes('credentialsIncluded'));
  assert.ok(prompt.includes('/root/projects/DSH Backup ALL'), '应注入 pluginRoot');
  assert.ok(prompt.includes('backup_get_inventory'));
  assert.ok(prompt.length < 20000);
});

// ---------------------------------------------------------------------------
// 系统提示词
// ---------------------------------------------------------------------------

const SNAPSHOT_TOOLS = [
  'backup_get_inventory',
  'backup_set_progress',
  'backup_list_dir',
  'backup_read_text',
  'backup_stat',
  'backup_add_path',
  'backup_remove_path',
  'backup_set_restore_plan',
  'backup_write_restore_doc',
  'backup_log',
  'backup_build',
];

const RESTORE_TOOLS = [
  'restore_inspect_archive',
  'restore_compare',
  'restore_set_progress',
  'restore_log',
  'restore_apply_files',
  'restore_reinstall_dependencies',
  'restore_finish',
];

test('快照系统提示词包含全部 11 个工具与关键 SOP 语义', () => {
  const prompt = SNAPSHOT_SYSTEM_PROMPT;
  assert.ok(prompt.length > 4000, '系统提示词不应过短');
  for (const tool of SNAPSHOT_TOOLS) {
    assert.ok(prompt.includes(tool), `快照提示词缺少工具：${tool}`);
  }
  // 角色/目标/环境事实/包结构
  assert.ok(prompt.includes('DSH 备份管理员'));
  assert.ok(prompt.includes('快照包结构'));
  assert.ok(prompt.includes('manifest.json'));
  assert.ok(prompt.includes('restore-plan.json'));
  assert.ok(prompt.includes('RESTORE.md'));
  assert.ok(prompt.includes('INVENTORY.md'));
  // 工作流程关键动作
  assert.ok(prompt.includes('backup_get_inventory'));
  assert.ok(prompt.includes('backup_build'));
  assert.ok(prompt.includes('最后一步'));
  // 外部文件判定与红线
  assert.ok(prompt.includes('插件本体之外的外部文件'));
  assert.ok(prompt.includes('dshbox-plugins'));
  assert.ok(prompt.includes('node_modules'));
  assert.ok(prompt.includes('只读探索'));
  assert.ok(prompt.includes('.credentials.yaml'));
  assert.ok(prompt.includes('明文'));
  assert.ok(prompt.includes('轮换'));
  // 进度节奏（30~60 秒）
  assert.ok(prompt.includes('30~60 秒'));
  // 中断语义
  assert.ok(prompt.includes('INTERRUPT_INSTRUCTION'));
  assert.ok(prompt.includes('立即停止'));
  assert.ok(prompt.includes('未执行打包'));
});

test('恢复系统提示词包含全部 7 个工具与安全约束', () => {
  const prompt = RESTORE_SYSTEM_PROMPT;
  assert.ok(prompt.length > 3000, '系统提示词不应过短');
  for (const tool of RESTORE_TOOLS) {
    assert.ok(prompt.includes(tool), `恢复提示词缺少工具：${tool}`);
  }
  assert.ok(prompt.includes('DSH 恢复管理员'));
  assert.ok(prompt.includes('恢复前快照'));
  assert.ok(prompt.includes('重启 DSH'));
  assert.ok(prompt.includes('插件代码本体'));
  assert.ok(prompt.includes('只恢复快照内条目'));
  assert.ok(prompt.includes('不会删除') || prompt.includes('不删除'));
  assert.ok(prompt.includes('密钥') || prompt.includes('凭据'));
  // 依赖重装工具的使用条件
  assert.ok(prompt.includes('依赖确实变化'));
  assert.ok(prompt.includes('需要网络'));
  // 完成摘要三要素
  assert.ok(prompt.includes('恢复了什么'));
  assert.ok(prompt.includes('需人工确认'));
  // 中断语义
  assert.ok(prompt.includes('INTERRUPT_INSTRUCTION'));
});

test('INTERRUPT_INSTRUCTION 明确要求停手且禁止收尾工具', () => {
  const text = INTERRUPT_INSTRUCTION;
  assert.ok(text.includes('用户已中断'));
  assert.ok(text.includes('立即停止'));
  assert.ok(text.includes('backup_build'));
  assert.ok(text.includes('restore_apply_files'));
  assert.ok(text.includes('restore_finish'));
  assert.ok(text.includes('不要写入') || text.includes('未改动任何文件'));
});

// ---------------------------------------------------------------------------
// 用户提示词
// ---------------------------------------------------------------------------

function makeBigInventory() {
  const inventory = makeManifest().inventory;
  return {
    ...inventory,
    bundles: Array.from({ length: 120 }, (_, index) => ({
      name: `bundle-${index}`,
      version: `1.0.${index}`,
      availability: index % 2 === 0 ? 'profile' : 'installation',
      enabled: true,
      rows: [{ rowId: `row-${index}` }],
    })),
    plugins: Array.from({ length: 80 }, (_, index) => ({
      packageName: `plugin-${index}`,
      version: '1.0.0',
      kind: 'dependency',
    })),
    skills: Array.from({ length: 80 }, (_, index) => ({
      name: `skill-${index}`,
      path: `/root/projects/.dsh/skills/skill-${index}`,
      source: 'user-dsh',
    })),
    externalCandidates: Array.from({ length: 80 }, (_, index) => ({
      path: `/root/projects/.dsh/external-dir-${index}`,
      why: '插件数据目录，运行时读取',
      kind: 'data',
    })),
    warnings: Array.from({ length: 50 }, (_, index) => `warning-${index}: 很长的扫描警告文本`),
  };
}

test('renderSnapshotUserPrompt 注入关键信息且不泄漏密钥', () => {
  const prompt = renderSnapshotUserPrompt({
    snapshotName: '我的快照',
    description: '测试描述',
    inventory: makeBigInventory(),
    config: {
      dshHome: '/root/projects/.dsh',
      profileName: 'web',
      backupDir: '/root/projects/DSH Backup ALL/backup',
      apiKey: 'sk-should-not-leak',
      baseURL: 'https://example.com/v1',
    },
  });

  assert.ok(prompt.includes('我的快照'));
  assert.ok(prompt.includes('测试描述'));
  assert.ok(prompt.includes('/root/projects/.dsh'));
  assert.ok(prompt.includes('backup_get_inventory'));
  assert.ok(prompt.includes('backup_set_progress'));
  assert.ok(prompt.includes('backup_build'));
  assert.ok(prompt.includes('/root/projects/.dsh/external-dir-0'), '应包含外部候选路径');
  assert.ok(!prompt.includes('sk-should-not-leak'), '配置里的 API Key 不得进入提示词');
  assert.ok(prompt.length < 20000, `用户提示词过长：${prompt.length}`);
});

test('renderSnapshotUserPrompt 空参数容错', () => {
  const prompt = renderSnapshotUserPrompt();
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.includes('（未命名'));
  assert.ok(prompt.includes('backup_get_inventory'));
});

test('renderRestoreUserPrompt 注入快照/归档/计划摘要且长度受控', () => {
  const manifest = makeManifest();
  const prompt = renderRestoreUserPrompt({
    recordName: '待恢复快照',
    description: '恢复测试',
    archivePath: '/tmp/dsh-restore-abc',
    manifest,
    restorePlan: PLAN,
    currentInventory: makeBigInventory(),
  });

  assert.ok(prompt.includes('待恢复快照'));
  assert.ok(prompt.includes('恢复测试'));
  assert.ok(prompt.includes('/tmp/dsh-restore-abc'));
  assert.ok(prompt.includes('files/3_xingxi'));
  assert.ok(prompt.includes('/root/projects/.dsh/xingxi'));
  assert.ok(prompt.includes('恢复配置文件'));
  assert.ok(prompt.includes('restore_inspect_archive'));
  assert.ok(prompt.includes('restore_compare'));
  assert.ok(prompt.includes('restore_apply_files'));
  assert.ok(prompt.includes('restore_reinstall_dependencies'));
  assert.ok(prompt.includes('restore_finish'));
  assert.ok(prompt.includes('重启 DSH'));
  assert.ok(prompt.length < 20000, `用户提示词过长：${prompt.length}`);
  assert.ok(!prompt.includes('supersecret-token'), 'manifest 摘要不得泄漏密钥');
});

test('renderRestoreUserPrompt 空参数容错', () => {
  const prompt = renderRestoreUserPrompt();
  assert.equal(typeof prompt, 'string');
  assert.ok(prompt.includes('未命名'));
  assert.ok(prompt.includes('restore_inspect_archive'));
});
