/**
 * test/archive.test.mjs — lib/archive.js 的单元测试（node:test，零第三方依赖）。
 *
 * 覆盖契约 A 节的 5 类用例：
 * 1. pack → extract 往返：逐文件 sha256 相等（含空目录/长路径/中文名/符号链接/1MB 大文件）
 * 2. listArchive 条目/大小/类型/截断
 * 3. 压缩率：可重复文本 ratio < 0.35，并记录真实值
 * 4. 安全：手工构造含 `../evil` / 绝对路径 / 符号链接借道逃逸的裸 tar → 解包必须抛错且不落盘
 * 5. formatBytes 边界
 * 另加：sha256File 正确性、exclude 前缀、onProgress 节流、AbortSignal、手工 PAX 归档解析。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import {
  packDirectoryBrotli,
  extractArchive,
  listArchive,
  formatBytes,
  sha256File,
} from '../lib/archive.js';

const TMP_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-archive-test-'));
const FIXED_MTIME = new Date('2021-06-01T12:34:56.000Z');

after(async () => {
  await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

/* ------------------------------------------------------------------ */
/* 测试辅助                                                            */
/* ------------------------------------------------------------------ */

async function exists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function writeTreeFile(rootDir, relPath, content, options = {}) {
  const abs = path.join(rootDir, ...relPath.split('/'));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
  if (options.mode !== undefined) await fsp.chmod(abs, options.mode);
  if (options.mtime !== undefined) await fsp.utimes(abs, options.mtime, options.mtime);
  return abs;
}

/** 递归快照：路径 -> {type, sha256/target, size, mode}（不含 mtime，mtime 单独断言）。 */
async function snapshotTree(rootDir) {
  const snapshot = new Map();

  async function walk(dirAbs, relDir) {
    const dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const abs = path.join(dirAbs, dirent.name);
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      const stat = await fsp.lstat(abs);
      if (stat.isDirectory()) {
        snapshot.set(rel, { type: 'dir', mode: stat.mode & 0o777 });
        await walk(abs, rel);
      } else if (stat.isSymbolicLink()) {
        snapshot.set(rel, { type: 'symlink', target: await fsp.readlink(abs) });
      } else {
        snapshot.set(rel, {
          type: 'file',
          size: stat.size,
          mode: stat.mode & 0o777,
          sha256: await sha256File(abs),
        });
      }
    }
  }

  await walk(rootDir, '');
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* 手工构造 tar（用于安全用例与 PAX 解析用例；不依赖被测模块的写入器） */
/* ------------------------------------------------------------------ */

function craftedTarHeader({ name, type = '0', size = 0, mode = 0o644, mtime = 1700000000, linkname = '' }) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write((mode & 0o7777).toString(8).padStart(7, '0') + '\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  header.write(mtime.toString(8).padStart(11, '0') + '\0', 136, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  if (linkname) header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  let checksum = 0;
  for (let i = 0; i < 512; i += 1) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0'), 148, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function padToBlock(buffer) {
  if (buffer.length === 0) return Buffer.alloc(0);
  const remainder = buffer.length % 512;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(512 - remainder)]);
}

function craftedPaxRecord(key, value) {
  const payload = ` ${key}=${value}\n`;
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  let total = payloadBytes + 1;
  for (;;) {
    const next = payloadBytes + String(total).length;
    if (next === total) break;
    total = next;
  }
  return Buffer.from(`${total}${payload}`, 'utf8');
}

function buildCraftedTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const isDir = entry.type === 'dir';
    const isLink = entry.type === 'symlink';
    const content = Buffer.from(entry.content ?? '', 'utf8');
    const type = isDir ? '5' : isLink ? '2' : '0';
    const size = isDir || isLink ? 0 : content.length;
    let name = entry.path + (isDir && !entry.path.endsWith('/') ? '/' : '');
    const needsPax = Buffer.byteLength(name, 'utf8') > 100 || /[^\x20-\x7e]/.test(name);
    if (needsPax) {
      const paxData = craftedPaxRecord('path', name);
      chunks.push(craftedTarHeader({ name: '././@PaxHeader', type: 'x', size: paxData.length }));
      chunks.push(padToBlock(paxData));
      name = 'pax-placeholder';
    }
    chunks.push(craftedTarHeader({ name, type, size, linkname: isLink ? entry.linkTarget : '' }));
    if (size > 0) chunks.push(padToBlock(content));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

async function writeCraftedArchive(fileName, entries) {
  const filePath = path.join(TMP_ROOT, fileName);
  await fsp.writeFile(filePath, zlib.brotliCompressSync(buildCraftedTar(entries)));
  return filePath;
}

/* ------------------------------------------------------------------ */
/* fixture 构造                                                        */
/* ------------------------------------------------------------------ */

/** 构造往返用例的 fixture 树，返回长路径文件的相对路径。 */
async function buildRoundtripFixture(src) {
  await fsp.mkdir(src, { recursive: true });
  await writeTreeFile(src, 'readme.txt', 'hello dsh backup\n', { mtime: FIXED_MTIME });
  await writeTreeFile(src, 'empty-file.txt', '');
  await writeTreeFile(src, 'nested/one.txt', 'one');
  await writeTreeFile(src, 'nested/deeper/two.txt', 'two');
  await writeTreeFile(src, 'executable.sh', '#!/bin/sh\necho hi\n', { mode: 0o755 });
  await fsp.mkdir(path.join(src, 'empty-dir'), { recursive: true });

  // >100 字节的长路径（目录 3 级 + 文件名）
  const longRel = [
    'long-directory-name-'.repeat(2), // 40 字节
    'x'.repeat(40),
    'y'.repeat(30),
    'long-file.txt',
  ].join('/');
  await writeTreeFile(src, longRel, 'long path content');

  // 中文路径（PAX 编码）
  await writeTreeFile(src, '中文目录/中文文件名.txt', '中文内容 ✓');
  await writeTreeFile(src, '中文目录/深度/子文件.md', '# 标题\n');

  // 符号链接（相对目标、目录链接、悬空链接）
  await fsp.symlink('readme.txt', path.join(src, 'link-to-readme.txt'));
  await fsp.symlink('nested', path.join(src, 'link-to-nested'));
  await fsp.symlink('does-not-exist.txt', path.join(src, 'broken-link.txt'));

  // 1MB 大文件（内容可压缩，避免 Q11 在纯随机数据上耗时过长）
  const bigParts = [];
  let bigSize = 0;
  let lineNo = 0;
  while (bigSize < 1024 * 1024) {
    const line = `row-${lineNo}-${(lineNo * 2654435761) % 1000003}\n`;
    bigParts.push(line);
    bigSize += Buffer.byteLength(line);
    lineNo += 1;
  }
  await writeTreeFile(src, 'big/big-file.bin', bigParts.join(''));

  return longRel;
}

/* ------------------------------------------------------------------ */
/* 1. 往返：sha256 全等                                                */
/* ------------------------------------------------------------------ */

test('pack → extract 往返：sha256 全等（空目录/长路径/中文名/符号链接/1MB 大文件/可执行位/mtime）', async () => {
  const src = path.join(TMP_ROOT, 'fixture-src');
  const dest = path.join(TMP_ROOT, 'fixture-dest');
  const outFile = path.join(TMP_ROOT, 'roundtrip.backup.tar.br');
  const longRel = await buildRoundtripFixture(src);

  const packProgress = [];
  const packed = await packDirectoryBrotli({
    sourceDir: src,
    outFile,
    onProgress: (progress) => packProgress.push(progress),
  });

  // 返回结构严格按契约
  assert.deepEqual(
    Object.keys(packed).sort(),
    ['bytes', 'dirs', 'durationMs', 'files', 'outFile', 'ratio', 'rawBytes', 'symlinks'].sort(),
  );
  assert.equal(packed.outFile, outFile);
  assert.ok(packed.bytes > 0, '压缩后字节数应 > 0');
  assert.ok(packed.rawBytes > packed.bytes, 'tar 原始字节数应大于压缩后字节数');
  assert.equal(packed.ratio, packed.bytes / packed.rawBytes);
  // rawBytes 记账必须等于真实 tar 流长度（解压后可验证），保证 ratio 可信
  const rawTar = zlib.brotliDecompressSync(await fsp.readFile(outFile));
  assert.equal(rawTar.length, packed.rawBytes, 'rawBytes 应等于解压后的 tar 字节数');
  assert.equal(rawTar.length % 512, 0, 'tar 流长度必须是 512 的整数倍');
  assert.ok(packed.ratio > 0 && packed.ratio < 1);
  assert.ok(Number.isInteger(packed.files) && packed.files > 0);
  assert.ok(Number.isInteger(packed.dirs) && packed.dirs > 0);
  assert.equal(packed.symlinks, 3);
  assert.ok(packed.durationMs >= 0);
  assert.equal(await exists(outFile), true);
  assert.equal(await exists(outFile + '.tmp'), false, '原子落盘后不应残留 .tmp');

  const extractProgress = [];
  const extracted = await extractArchive({
    archiveFile: outFile,
    destDir: dest,
    onProgress: (progress) => extractProgress.push(progress),
  });
  assert.equal(extracted.files, packed.files);
  assert.equal(extracted.dirs, packed.dirs);
  assert.equal(extracted.symlinks, packed.symlinks);
  assert.equal(extracted.entries.length, packed.files + packed.dirs + packed.symlinks);

  // 逐文件 sha256 + mode + 符号链接目标 + 空目录 全等
  const srcSnapshot = await snapshotTree(src);
  const destSnapshot = await snapshotTree(dest);
  assert.deepEqual(destSnapshot, srcSnapshot);

  // 关键项显式断言
  assert.equal((await fsp.lstat(path.join(dest, 'empty-dir'))).isDirectory(), true);
  const longSource = path.join(src, ...longRel.split('/'));
  const longDest = path.join(dest, ...longRel.split('/'));
  assert.ok(Buffer.byteLength(longRel, 'utf8') > 100, 'fixture 长路径应 > 100 字节');
  assert.equal(await sha256File(longDest), await sha256File(longSource));
  assert.equal(await fsp.readFile(longDest, 'utf8'), 'long path content');
  assert.equal(await fsp.readFile(path.join(dest, '中文目录/中文文件名.txt'), 'utf8'), '中文内容 ✓');
  assert.equal(
    await fsp.readFile(path.join(dest, '中文目录/深度/子文件.md'), 'utf8'),
    '# 标题\n',
  );

  const linkStat = await fsp.lstat(path.join(dest, 'link-to-readme.txt'));
  assert.equal(linkStat.isSymbolicLink(), true);
  assert.equal(await fsp.readlink(path.join(dest, 'link-to-readme.txt')), 'readme.txt');
  assert.equal((await fsp.lstat(path.join(dest, 'broken-link.txt'))).isSymbolicLink(), true);
  // NTFS 没有 POSIX exec 位；只在类 Unix 上断言
  if (process.platform !== 'win32') {
    assert.equal((await fsp.stat(path.join(dest, 'executable.sh'))).mode & 0o777, 0o755);
  }
  const bigDestStat = await fsp.stat(path.join(dest, 'big/big-file.bin'));
  assert.ok(bigDestStat.size >= 1024 * 1024, '1MB 大文件应完整还原');
  assert.equal(bigDestStat.size, (await fsp.stat(path.join(src, 'big/big-file.bin'))).size);

  // mtime 保留（tar 秒级精度）
  const srcMtime = (await fsp.stat(path.join(src, 'readme.txt'))).mtimeMs;
  const destMtime = (await fsp.stat(path.join(dest, 'readme.txt'))).mtimeMs;
  assert.equal(Math.floor(destMtime / 1000), Math.floor(srcMtime / 1000));

  // onProgress 契约：phase/done/total/percent、首尾、至少两次
  assert.ok(packProgress.length >= 2, 'onProgress 至少应在开始与结束各触发一次');
  assert.deepEqual(Object.keys(packProgress[0]).sort(), ['done', 'percent', 'phase', 'total']);
  assert.equal(packProgress[0].phase, 'pack');
  assert.equal(packProgress[0].percent, 0);
  assert.equal(packProgress.at(-1).percent, 100);
  assert.equal(packProgress.at(-1).done, packProgress.at(-1).total);
  assert.ok(extractProgress.length >= 2);
  assert.equal(extractProgress[0].phase, 'extract');
  assert.equal(extractProgress.at(-1).percent, 100);

  // 2. listArchive：条目数 / 大小 / 类型 / PAX 路径 / 截断
  const listed = await listArchive({ archiveFile: outFile });
  assert.equal(listed.total, extracted.entries.length);
  assert.equal(listed.entries.length, listed.total);
  assert.equal(listed.truncated, false);
  const byPath = new Map(listed.entries.map((entry) => [entry.path, entry]));
  assert.ok(byPath.has(longRel), 'listArchive 应通过 PAX 还原 >100 字节长路径');
  assert.ok(byPath.has('中文目录/中文文件名.txt'), 'listArchive 应还原中文路径');
  assert.equal(byPath.get('empty-dir')?.type, 'dir');
  assert.equal(byPath.get('link-to-readme.txt')?.type, 'symlink');
  const bigEntry = byPath.get('big/big-file.bin');
  assert.equal(bigEntry?.type, 'file');
  assert.equal(bigEntry?.size, bigDestStat.size);
  assert.ok(typeof bigEntry.mtime === 'string' && !Number.isNaN(Date.parse(bigEntry.mtime)));

  const truncated = await listArchive({ archiveFile: outFile, maxEntries: 3 });
  assert.equal(truncated.entries.length, 3);
  assert.equal(truncated.total, listed.total);
  assert.equal(truncated.truncated, true);
});

/* ------------------------------------------------------------------ */
/* 1b. tar 512 对齐回归（曾出现过的严重 bug：文件数据漏写 512 填充）    */
/* ------------------------------------------------------------------ */

/** 确定性伪随机字节（用于制造不可压缩但可复现的二进制内容）。 */
function pseudoRandomBytes(length, seed = 0x12345678) {
  const buffer = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    buffer[i] = (state >>> 16) & 0xff;
  }
  return buffer;
}

test('tar 对齐回归：多个非 512 整数倍大小的文件顺序写入后仍能正确解析/解包', async () => {
  const src = path.join(TMP_ROOT, 'align-src');
  const dest = path.join(TMP_ROOT, 'align-dest');
  const outFile = path.join(TMP_ROOT, 'align.backup.tar.br');
  // 关键：第 1 个以后每个文件 size % 512 != 0，漏写填充会让后续头全部错位
  const files = [
    ['a.txt', Buffer.from('x'.repeat(7859))], // 333 字节填充
    ['b.txt', Buffer.from('hello'.repeat(1000))], // 5000 字节，120 字节填充
    ['big.bin', pseudoRandomBytes(100003)], // 100003 字节，非整数倍
    ['c.bin', pseudoRandomBytes(1)],
    ['d.bin', pseudoRandomBytes(513)],
    ['sub/one.txt', Buffer.from('1')],
  ];
  for (const [rel, content] of files) await writeTreeFile(src, rel, content);
  assert.ok(files.some(([, content]) => content.length % 512 !== 0));

  const packed = await packDirectoryBrotli({ sourceDir: src, outFile });
  assert.equal(packed.files, files.length);
  const rawTar = zlib.brotliDecompressSync(await fsp.readFile(outFile));
  assert.equal(rawTar.length, packed.rawBytes);
  assert.equal(rawTar.length % 512, 0);

  const listed = await listArchive({ archiveFile: outFile });
  const expectedOrder = ['a.txt', 'b.txt', 'big.bin', 'c.bin', 'd.bin', 'sub', 'sub/one.txt'];
  assert.deepEqual(
    listed.entries.map((entry) => entry.path),
    expectedOrder,
    '条目顺序/路径应完整正确（错位时会解析出乱码路径）',
  );
  for (const [rel, content] of files) {
    const entry = listed.entries.find((item) => item.path === rel);
    assert.equal(entry.size, content.length, `${rel} 的 size 应正确`);
  }

  const extracted = await extractArchive({ archiveFile: outFile, destDir: dest });
  assert.equal(extracted.files, files.length);
  for (const [rel, content] of files) {
    const destFile = path.join(dest, ...rel.split('/'));
    assert.equal(await sha256File(destFile), crypto.createHash('sha256').update(content).digest('hex'));
    assert.equal((await fsp.stat(destFile)).size, content.length);
  }
  assert.deepEqual(await snapshotTree(dest), await snapshotTree(src));
});

/* ------------------------------------------------------------------ */
/* 3. 压缩率                                                           */
/* ------------------------------------------------------------------ */

test('压缩率：可重复文本 fixture 的 ratio < 0.35（记录真实值）', async (t) => {
  const src = path.join(TMP_ROOT, 'ratio-src');
  const outFile = path.join(TMP_ROOT, 'ratio.backup.tar.br');
  const line = 'The quick brown fox jumps over the lazy dog. 备份归档测试。\n';
  const content = line.repeat(40000);
  await writeTreeFile(src, 'repeat.txt', content);
  assert.ok(Buffer.byteLength(content) > 2 * 1024 * 1024, 'fixture 应 > 2MB');

  const packed = await packDirectoryBrotli({ sourceDir: src, outFile });
  assert.equal(packed.files, 1);
  assert.equal(packed.ratio, packed.bytes / packed.rawBytes);
  assert.ok(packed.ratio < 0.35, `ratio 应 < 0.35，实际 ${packed.ratio}`);
  t.diagnostic(
    `真实压缩率 ratio = ${packed.ratio.toFixed(6)}（${packed.bytes} / ${packed.rawBytes} 字节，约 ${(
      (1 / packed.ratio) *
      1
    ).toFixed(1)}x）`,
  );
});

/* ------------------------------------------------------------------ */
/* 4. 路径穿越防护                                                      */
/* ------------------------------------------------------------------ */

test('路径穿越防护：`..`、绝对路径、符号链接借道逃逸均抛错且不落盘', async () => {
  const cases = [
    { label: '../evil.txt', outName: 'evil.txt' },
    { label: 'files/../../evil2.txt', outName: 'evil2.txt' },
  ];
  for (const item of cases) {
    const archiveFile = await writeCraftedArchive(
      `evil-${path.basename(item.outName)}.tar.br`,
      [{ path: item.label, content: 'evil' }],
    );
    const destDir = path.join(TMP_ROOT, `safety-${path.basename(item.outName)}`);
    await assert.rejects(
      () => extractArchive({ archiveFile, destDir }),
      /拒绝解包|非法|越界/,
      `含 ${item.label} 的归档必须被拒绝`,
    );
    assert.equal(
      await exists(path.join(TMP_ROOT, item.outName)),
      false,
      `不应在 destDir 之外写出 ${item.outName}`,
    );
  }

  // 绝对路径
  const absoluteTarget = path.join(TMP_ROOT, 'abs-evil.txt');
  const absArchive = await writeCraftedArchive('evil-abs.tar.br', [
    { path: absoluteTarget, content: 'evil' },
  ]);
  await assert.rejects(
    () => extractArchive({ archiveFile: absArchive, destDir: path.join(TMP_ROOT, 'safety-abs') }),
    /拒绝解包|绝对路径/,
  );
  assert.equal(await exists(absoluteTarget), false);

  // 先解出符号链接，再借它写到 destDir 之外：必须拒绝且外部目录不被写入
  const outsideDir = path.join(TMP_ROOT, 'outside-dir');
  await fsp.mkdir(outsideDir, { recursive: true });
  const symlinkArchive = await writeCraftedArchive('evil-symlink.tar.br', [
    { path: 'escape-link', type: 'symlink', linkTarget: outsideDir },
    { path: 'escape-link/pwned.txt', content: 'pwned' },
  ]);
  await assert.rejects(
    () => extractArchive({ archiveFile: symlinkArchive, destDir: path.join(TMP_ROOT, 'safety-link') }),
    /拒绝解包|符号链接/,
  );
  assert.equal(await exists(path.join(outsideDir, 'pwned.txt')), false);
});

/* ------------------------------------------------------------------ */
/* 5. formatBytes 边界                                                 */
/* ------------------------------------------------------------------ */

test('formatBytes 边界', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1 MB');
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(formatBytes(2 * 1024 ** 3), '2 GB');
  assert.equal(formatBytes(1024 ** 4), '1 TB');
});

/* ------------------------------------------------------------------ */
/* 附加：sha256File / exclude / AbortSignal / 手工 PAX 归档            */
/* ------------------------------------------------------------------ */

test('sha256File 与 node:crypto 结果一致', async () => {
  const target = path.join(TMP_ROOT, 'sha.txt');
  await fsp.writeFile(target, 'abc');
  const expected = crypto.createHash('sha256').update('abc').digest('hex');
  assert.equal(await sha256File(target), expected);
});

test('exclude 绝对路径前缀会被跳过，onProgress 首尾有值', async () => {
  const src = path.join(TMP_ROOT, 'exclude-src');
  await writeTreeFile(src, 'keep/a.txt', 'a');
  await writeTreeFile(src, 'keep/b.txt', 'b');
  await writeTreeFile(src, 'skip/x.txt', 'x');
  await writeTreeFile(src, 'skip/sub/y.txt', 'y');
  await writeTreeFile(src, 'skip-single.txt', 's');
  const outFile = path.join(TMP_ROOT, 'exclude.backup.tar.br');

  const progress = [];
  const packed = await packDirectoryBrotli({
    sourceDir: src,
    outFile,
    exclude: [path.join(src, 'skip'), path.join(src, 'skip-single.txt')],
    onProgress: (item) => progress.push(item),
  });
  assert.equal(packed.files, 2);
  assert.equal(packed.dirs, 1);

  const listed = await listArchive({ archiveFile: outFile });
  const paths = listed.entries.map((entry) => entry.path);
  assert.ok(paths.includes('keep'));
  assert.ok(paths.includes('keep/a.txt'));
  assert.ok(paths.includes('keep/b.txt'));
  assert.ok(!paths.some((item) => item === 'skip' || item.startsWith('skip/')));
  assert.ok(!paths.includes('skip-single.txt'));
  assert.ok(progress.length >= 2);
  assert.equal(progress[0].percent, 0);
  assert.equal(progress.at(-1).percent, 100);
});

test('AbortSignal 已中止：立即抛 AbortError 且不残留输出文件/.tmp', async () => {
  const src = path.join(TMP_ROOT, 'abort-src');
  await writeTreeFile(src, 'a.txt', 'a');
  const outFile = path.join(TMP_ROOT, 'aborted.backup.tar.br');
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => packDirectoryBrotli({ sourceDir: src, outFile, signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(await exists(outFile), false);
  assert.equal(await exists(outFile + '.tmp'), false);

  await assert.rejects(
    () => extractArchive({ archiveFile: outFile, destDir: path.join(TMP_ROOT, 'abort-dest'), signal: controller.signal }),
    (error) => error.name === 'AbortError',
  );
});

test('手工构造的 PAX 归档：listArchive 与 extractArchive 都能还原 >100 字节中文长路径', async () => {
  const deepRel = ['p'.repeat(60), 'q'.repeat(60), '中文文件.txt'].join('/');
  assert.ok(Buffer.byteLength(deepRel, 'utf8') > 100);
  const archiveFile = await writeCraftedArchive('pax-crafted.tar.br', [
    { path: deepRel, content: 'pax 内容' },
  ]);

  const listed = await listArchive({ archiveFile });
  assert.equal(listed.total, 1);
  assert.equal(listed.entries[0].path, deepRel);
  assert.equal(listed.entries[0].type, 'file');
  assert.equal(listed.entries[0].size, Buffer.byteLength('pax 内容'));

  const destDir = path.join(TMP_ROOT, 'pax-dest');
  const extracted = await extractArchive({ archiveFile, destDir });
  assert.equal(extracted.files, 1);
  assert.equal(extracted.entries[0].path, deepRel);
  assert.equal(await fsp.readFile(path.join(destDir, ...deepRel.split('/')), 'utf8'), 'pax 内容');
});
