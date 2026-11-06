// v1.1.0：跨平台事实（OS 检测、文件名、引用、路径大小写、权限语义）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectOsType, osLabel, osTypeFromName, snapshotFileName, snapshotFileBase,
  sanitizeFileStem, quoteCmdArg, pathCompareKey, permissionModeSupported,
} from '../lib/platform.js'
import { resolveEnv, defaultSnapshotName } from '../lib/paths.js'

test('detectOsType/osLabel：linux/win32 映射与展示名', () => {
  assert.equal(detectOsType('linux'), 'linux')
  assert.equal(detectOsType('win32'), 'windows')
  assert.equal(detectOsType('darwin'), 'other')
  assert.equal(osLabel('linux'), 'Linux')
  assert.equal(osLabel('windows'), 'Windows')
  assert.equal(osLabel('unknown'), '未知')
})

test('osTypeFromName：只认独立 token，避免 windows 路径误判', () => {
  assert.equal(osTypeFromName('2026-11-06 10-30-00-linux.backup.tar.br'), 'linux')
  assert.equal(osTypeFromName('x-windows.backup.tar.br'), 'windows')
  assert.equal(osTypeFromName('mywindowsfile'), null)
  assert.equal(osTypeFromName(''), null)
})

test('snapshotFileName：{stamp}-{osType}.backup.tar.br，未知/非法退 other', () => {
  assert.equal(snapshotFileName('2026-11-06 10-30-00', 'linux'), '2026-11-06 10-30-00-linux.backup.tar.br')
  assert.equal(snapshotFileName('2026-11-06 10-30-00', 'windows'), '2026-11-06 10-30-00-windows.backup.tar.br')
  assert.equal(snapshotFileBase('2026-11-06 10-30-00', 'weird'), '2026-11-06 10-30-00-other')
})

test('defaultSnapshotName 带 osType；resolveEnv 支持 osType/platform 覆盖', () => {
  const name = defaultSnapshotName(new Date('2026-11-06T10:30:00Z'), 'linux')
  assert.match(name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}-linux$/)
  const env = resolveEnv({ dshHome: '/tmp/x', profileName: 'web', osType: 'windows' })
  assert.equal(env.osType, 'windows')
  assert.equal(env.platform, process.platform)
})

test('sanitizeFileStem：Windows 非法字符/保留名/尾点空格', () => {
  assert.equal(sanitizeFileStem('a<b>c:"d"|e?f*'), 'a-b-c--d--e-f-')
  assert.equal(sanitizeFileStem('CON'), '_CON')
  assert.equal(sanitizeFileStem('com1.backup'), '_com1.backup')
  assert.equal(sanitizeFileStem('  name.  '), 'name')
  assert.equal(sanitizeFileStem(''), 'snapshot')
  assert.equal(sanitizeFileStem('../../etc/passwd'), 'passwd')
})

test('quoteCmdArg：Windows cmd 特殊字符引用', () => {
  assert.equal(quoteCmdArg('plain'), 'plain')
  assert.equal(quoteCmdArg('a b'), '"a b"')
  assert.match(quoteCmdArg('a&b'), /^".*"$/)
  assert.equal(quoteCmdArg(''), '""')
})

test('pathCompareKey：Windows 大小写/分隔符归一，Linux 保持原样', () => {
  assert.equal(pathCompareKey('C:\\Users\\A\\x', 'win32'), pathCompareKey('c:/users/a/x', 'win32'))
  assert.equal(pathCompareKey('C:\\Users\\A\\x', 'win32'), 'c:\\users\\a\\x')
  assert.notEqual(pathCompareKey('/tmp/A', 'linux'), pathCompareKey('/tmp/a', 'linux'))
})

test('permissionModeSupported：Windows 不写 0600', () => {
  assert.equal(permissionModeSupported('linux'), true)
  assert.equal(permissionModeSupported('win32'), false)
})
