/**
 * lib/archive.js — tar + Brotli 高压缩归档模块。
 *
 * 纯 Node 内置模块实现：不依赖第三方包、不起子进程，也不把大文件读进内存。
 *
 * 设计要点（为什么这样做）：
 * 1. 打包分两步：先递归 walk 只收集元数据（大小/mode/mtime/符号链接目标），再流式写 tar；
 *    walk 得到的总字节估算用来设置 Brotli 的 SIZE_HINT，同时给进度回调提供 total。
 * 2. 原子落盘：先写 `<outFile>.tmp`，全部成功后才 rename；失败/被中止时清理 tmp，
 *    不会留下半截压缩包让上层误以为备份成功。
 * 3. 长路径（>100 字节）与非 ASCII（中文）路径用 PAX 扩展头（type 'x'）编码，
 *    避免 ustar 100 字节 name 字段截断/乱码。
 * 4. 解包安全优先：绝对路径、含 `..` 的路径、解析后逃逸 destDir 的一律抛中文 Error；
 *    父目录逐级 lstat 校验，避免「先解出符号链接、再借它写到 destDir 之外」的攻击。
 * 5. Brotli：quality 11（最高压缩）、lgwin 24（16MB 窗口）、SIZE_HINT=tar 原始字节估算。
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createBrotliCompress,
  createBrotliDecompress,
  constants as zlibConstants,
} from 'node:zlib';
import { finished } from 'node:stream/promises';

const BLOCK_SIZE = 512; // tar 块大小
const ZERO_BLOCK = Buffer.alloc(BLOCK_SIZE);
const MAX_OCTAL_11 = 0o77777777777; // ustar size/mtime 字段上限（11 位八进制）
const PAX_SIZE_LIMIT = 4 * 1024 * 1024; // PAX 扩展头大小上限，防恶意归档撑爆内存
const PROGRESS_ENTRY_STEP = 200; // 每 ~200 个条目汇报一次进度
const PROGRESS_BYTE_STEP = 2 * 1024 * 1024; // 或每 ~2MB 汇报一次
const PROGRESS_MIN_INTERVAL_MS = 250; // 再兜一层时间节流，别太频繁
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

const PROCESS_UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const PROCESS_GID = typeof process.getgid === 'function' ? process.getgid() : 0;

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

/** 若 signal 已中止则抛出 name='AbortError' 的 Error（中文消息）。 */
function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error('归档操作已取消');
    err.name = 'AbortError';
    if (signal.reason !== undefined) err.cause = signal.reason;
    throw err;
  }
}

/** size -> tar 数据区实际占用（512 对齐），0 字节文件不占数据块。 */
function paddedLength(size) {
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
}

/** 按字节安全截断 UTF-8 字符串（不会切在半个汉字上）。 */
function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1; // 回退到 UTF-8 首字节边界
  return bytes.subarray(0, end).toString('utf8');
}

/** 是否必须走 PAX 扩展头：超过 ustar 100 字节字段，或含非可打印 ASCII（如中文）。 */
function needsPaxText(text) {
  return Buffer.byteLength(text, 'utf8') > 100 || /[^\x20-\x7e]/.test(text);
}

/** 把秒值格式化进 PAX mtime 记录（保留毫秒精度，去掉多余的 0）。 */
function formatMtimeSeconds(ms) {
  return (ms / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** 写一个不可分割的流块，等待它真正被处理（回调式，天然支持背压）。 */
function writeToStream(stream, buffer) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || stream.writableEnded) {
      reject(new Error('归档写入流已关闭'));
      return;
    }
    stream.write(buffer, (err) => (err ? reject(err) : resolve()));
  });
}

async function writeZeros(stream, count) {
  let left = count;
  while (left > 0) {
    const take = Math.min(left, ZERO_BLOCK.length);
    await writeToStream(stream, take === ZERO_BLOCK.length ? ZERO_BLOCK : ZERO_BLOCK.subarray(0, take));
    left -= take;
  }
}

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** 进度上报器：按条目数/字节数 + 最小间隔节流，首尾各强制一次。 */
function createProgressReporter(onProgress, { phase, total, percent }) {
  const noop = { update() {}, finish() {} };
  if (typeof onProgress !== 'function') return noop;
  let lastDone = 0;
  let lastBytes = 0;
  let lastAt = 0;
  const emit = (done, bytes, value) => {
    lastDone = done;
    lastBytes = bytes;
    lastAt = Date.now();
    try {
      onProgress({ phase, done, total, percent: value });
    } catch {
      // 进度回调是展示用途，抛错不应毁掉正在进行的归档
    }
  };
  emit(0, 0, 0);
  return {
    update(done, bytes) {
      const entryDelta = done - lastDone;
      const byteDelta = bytes - lastBytes;
      if (entryDelta < PROGRESS_ENTRY_STEP && byteDelta < PROGRESS_BYTE_STEP) return;
      if (Date.now() - lastAt < PROGRESS_MIN_INTERVAL_MS) return;
      emit(done, bytes, Math.min(99, Math.max(0, Math.round(percent(done, bytes)))));
    },
    finish(done, bytes) {
      emit(done, bytes, 100);
    },
  };
}

/* ------------------------------------------------------------------ */
/* tar 头部读写                                                        */
/* ------------------------------------------------------------------ */

function writeFieldString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`tar 头字段超出 ${length} 字节限制: ${value}`);
  bytes.copy(buffer, offset);
}

function writeFieldOctal(buffer, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`tar 八进制字段值非法: ${value}`);
  }
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new Error(`tar 八进制字段溢出: ${value}`);
  buffer.write('0'.repeat(length - 1 - octal.length) + octal, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function readFieldString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.toString('utf8', 0, nul === -1 ? length : nul);
}

function readFieldOctal(buffer, offset, length) {
  const raw = buffer.toString('ascii', offset, offset + length);
  const text = raw.replace(/\0.*$/s, '').trim();
  const match = text.match(/^[0-7]+/);
  return match ? Number.parseInt(match[0], 8) : 0;
}

function isZeroBlock(buffer) {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] !== 0) return false;
  }
  return true;
}

/** 构造一个 ustar 头（512 字节）。长路径由调用方用 PAX 覆盖，这里只放占位名。 */
function buildTarHeader({
  name,
  mode = 0o644,
  uid = PROCESS_UID,
  gid = PROCESS_GID,
  size = 0,
  mtime = 0,
  typeflag = '0',
  linkname = '',
}) {
  const header = Buffer.alloc(BLOCK_SIZE);
  writeFieldString(header, 0, 100, truncateUtf8(name, 100));
  writeFieldOctal(header, 100, 8, mode & 0o7777);
  writeFieldOctal(header, 108, 8, uid & 0o7777777);
  writeFieldOctal(header, 116, 8, gid & 0o7777777);
  writeFieldOctal(header, 124, 12, size);
  writeFieldOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156); // 计算校验和时该字段按 8 个空格算
  header.write(typeflag, 156, 1, 'ascii');
  if (linkname) writeFieldString(header, 157, 100, truncateUtf8(linkname, 100));
  writeFieldString(header, 257, 6, 'ustar'); // 257..262 = "ustar\0"
  writeFieldString(header, 263, 2, '00');
  writeFieldString(header, 265, 32, 'root');
  writeFieldString(header, 297, 32, 'root');
  writeFieldOctal(header, 329, 8, 0); // devmajor
  writeFieldOctal(header, 337, 8, 0); // devminor
  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/** 构造一条 PAX 记录：`<总长度> <key>=<value>\n`（长度包含自己的位数）。 */
function paxRecord(key, value) {
  const payload = ` ${key}=${value}\n`;
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  let total = payloadBytes + 1; // 先假设长度是 1 位数
  for (;;) {
    const digits = String(total).length;
    const next = payloadBytes + digits;
    if (next === total) break;
    total = next;
  }
  return Buffer.from(`${total}${payload}`, 'utf8');
}

/** 解析 PAX 扩展头数据区。 */
function parsePaxRecords(buffer) {
  const records = Object.create(null);
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(buffer.toString('ascii', offset, space), 10);
    if (!Number.isFinite(length) || length <= 0 || offset + length > buffer.length) break;
    const body = buffer.toString('utf8', space + 1, offset + length);
    const eq = body.indexOf('=');
    if (eq > 0) {
      let value = body.slice(eq + 1);
      if (value.endsWith('\n')) value = value.slice(0, -1);
      records[body.slice(0, eq)] = value;
    }
    offset += length;
  }
  return records;
}

/* ------------------------------------------------------------------ */
/* 目录遍历（打包第一遍：只读元数据）                                  */
/* ------------------------------------------------------------------ */

function normalizeExcludes(exclude) {
  if (exclude === undefined || exclude === null) return [];
  const list = Array.isArray(exclude) ? exclude : [exclude];
  return list
    .filter((item) => typeof item === 'string' && item.length > 0)
    .map((item) => path.resolve(item).replace(/[\\/]+$/, ''));
}

function isExcluded(absolutePath, excludes) {
  for (const prefix of excludes) {
    if (absolutePath === prefix) return true;
    if (absolutePath.startsWith(prefix + path.sep)) return true;
  }
  return false;
}

/**
 * 递归收集待打包条目（目录/文件/符号链接），按名称排序保证输出稳定。
 * 不跟随符号链接（符号链接本身就是条目），其它类型（fifo/socket/设备）跳过。
 */
async function collectEntries(rootDir, { excludes, signal, skipPaths }) {
  const entries = [];

  async function visit(dirAbs, relDir) {
    throwIfAborted(signal);
    let dirents;
    try {
      dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return; // 扫描期间目录消失：跳过，不让整个备份失败
      throw err;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      throwIfAborted(signal);
      const abs = path.join(dirAbs, dirent.name);
      const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
      if (skipPaths.has(abs)) continue; // 输出文件/tmp 若落在源目录里，不要把自己打进去
      if (isExcluded(abs, excludes)) continue;
      let stat;
      try {
        stat = await fsp.lstat(abs);
      } catch (err) {
        if (err.code === 'ENOENT') continue; // 扫描期间被删：跳过
        throw err;
      }
      if (stat.isDirectory()) {
        entries.push({
          abs,
          rel,
          type: 'dir',
          size: 0,
          mode: stat.mode & 0o7777,
          mtimeMs: stat.mtimeMs,
          linkTarget: null,
        });
        await visit(abs, rel);
      } else if (stat.isSymbolicLink()) {
        let linkTarget = '';
        try {
          linkTarget = await fsp.readlink(abs);
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        entries.push({
          abs,
          rel,
          type: 'symlink',
          size: 0,
          mode: stat.mode & 0o7777,
          mtimeMs: stat.mtimeMs,
          linkTarget,
        });
      } else if (stat.isFile()) {
        entries.push({
          abs,
          rel,
          type: 'file',
          size: stat.size,
          mode: stat.mode & 0o7777,
          mtimeMs: stat.mtimeMs,
          linkTarget: null,
        });
      }
      // 其余类型（fifo/socket/字符设备等）跳过：tar 语义不通用，恢复也无意义
    }
  }

  await visit(rootDir, '');
  return entries;
}

/** 估算 tar 流原始字节数，仅用于 Brotli SIZE_HINT，不需要精确。 */
function estimateTarBytes(entries) {
  let total = 2 * BLOCK_SIZE; // 结尾两个零块
  for (const entry of entries) {
    const relName = entry.type === 'dir' ? `${entry.rel}/` : entry.rel;
    total += BLOCK_SIZE;
    if (needsPaxText(relName) || (entry.type === 'symlink' && needsPaxText(entry.linkTarget || ''))) {
      total += 2 * BLOCK_SIZE; // PAX 头 + 数据块（估）
    }
    if (entry.type === 'file') total += paddedLength(entry.size);
  }
  return total;
}

/** 为单个条目计算写入计划（头部字节、PAX 数据、类型、大小）。 */
function planEntry(entry) {
  const relName = entry.type === 'dir' ? `${entry.rel}/` : entry.rel;
  const typeflag = entry.type === 'dir' ? '5' : entry.type === 'symlink' ? '2' : '0';
  const size = entry.type === 'file' ? entry.size : 0;
  const linkTarget = entry.type === 'symlink' ? entry.linkTarget || '' : '';
  const pathNeedsPax = needsPaxText(relName);
  const linkNeedsPax = entry.type === 'symlink' && needsPaxText(linkTarget);
  const sizeNeedsPax = size > MAX_OCTAL_11;
  const mtimeSeconds = Math.max(0, Math.floor(entry.mtimeMs / 1000));
  const mtimeFraction = entry.mtimeMs / 1000 - mtimeSeconds;

  let paxData = null;
  if (pathNeedsPax || linkNeedsPax || sizeNeedsPax) {
    const records = [];
    if (pathNeedsPax) records.push(paxRecord('path', relName));
    if (linkNeedsPax) records.push(paxRecord('linkpath', linkTarget));
    if (sizeNeedsPax) records.push(paxRecord('size', String(size)));
    if (mtimeFraction > 0) records.push(paxRecord('mtime', formatMtimeSeconds(entry.mtimeMs)));
    paxData = Buffer.concat(records);
  }

  const header = buildTarHeader({
    // 有 PAX 时 header 里的名字只是占位（解析方以 PAX path 为准），仍按 UTF-8 安全截断
    name: pathNeedsPax ? truncateUtf8(relName, 100) || 'pax-entry' : relName,
    mode: entry.mode,
    size,
    mtime: mtimeSeconds,
    typeflag,
    linkname: linkNeedsPax ? truncateUtf8(linkTarget, 100) : linkTarget,
  });

  return { relName, typeflag, size, paxData, header };
}

/* ------------------------------------------------------------------ */
/* Brotli 流工具                                                       */
/* ------------------------------------------------------------------ */

function createCompressor(sizeHint) {
  const params = {
    [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
  };
  if (Number.isFinite(sizeHint) && sizeHint > 0) {
    params[zlibConstants.BROTLI_PARAM_SIZE_HINT] = Math.min(Math.floor(sizeHint), 0x7fffffff);
  }
  return createBrotliCompress({ params });
}

/**
 * 打开归档文件为「解压后的异步可迭代流」，并统计已消费的压缩字节（用于进度）。
 * 读完/出错后必须调用 destroy() 释放 fd。
 */
function openBrotliReader(archiveFile) {
  const rs = createReadStream(archiveFile);
  const br = createBrotliDecompress();
  const state = { compressedRead: 0, destroyed: false };
  rs.on('data', (chunk) => {
    state.compressedRead += chunk.length;
  });
  rs.on('error', (err) => br.destroy(err));
  br.on('error', () => rs.destroy());
  rs.pipe(br);
  return {
    stream: br,
    get compressedRead() {
      return state.compressedRead;
    },
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      rs.destroy();
      br.destroy();
    },
  };
}

/* ------------------------------------------------------------------ */
/* tar 流读取器                                                        */
/* ------------------------------------------------------------------ */

/** 把解压后的字节流按需切成 tar 块，既支持整块读，也支持文件内容的流式搬移。 */
class TarReader {
  constructor(stream) {
    this._iterator = stream[Symbol.asyncIterator]();
    this._buffer = Buffer.alloc(0);
    this._eof = false;
  }

  async _pull() {
    if (this._eof) return false;
    const { value, done } = await this._iterator.next();
    if (done) {
      this._eof = true;
      return false;
    }
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this._buffer = this._buffer.length > 0 ? Buffer.concat([this._buffer, chunk]) : chunk;
    return true;
  }

  async _ensure(count) {
    while (this._buffer.length < count) {
      if (!(await this._pull())) return false;
    }
    return true;
  }

  /** 读一个 512 字节块；到文件尾返回 null。 */
  async readBlock() {
    if (!(await this._ensure(BLOCK_SIZE))) return null;
    const block = this._buffer.subarray(0, BLOCK_SIZE);
    this._buffer = this._buffer.subarray(BLOCK_SIZE);
    return block;
  }

  /** 读取正好 count 字节（用于 PAX/GNU 扩展头这种小数据）。 */
  async readExactly(count) {
    if (!(await this._ensure(count))) throw new Error('归档数据不完整：扩展头被截断');
    const out = this._buffer.subarray(0, count);
    this._buffer = this._buffer.subarray(count);
    return out;
  }

  /** 读取至多 max 字节（可能只返回当前缓冲区里的一段；文件内容流式搬移用）。 */
  async readSome(max) {
    if (this._buffer.length === 0 && !(await this._pull())) {
      throw new Error('归档数据不完整：文件内容被截断');
    }
    const count = Math.min(max, this._buffer.length);
    const out = this._buffer.subarray(0, count);
    this._buffer = this._buffer.subarray(count);
    return out;
  }

  /** 跳过 count 字节（tar 的 512 对齐填充/未支持类型的数据）。 */
  async skip(count) {
    let left = count;
    while (left > 0) {
      if (this._buffer.length === 0 && !(await this._pull())) {
        throw new Error('归档数据不完整：数据区被截断');
      }
      const take = Math.min(left, this._buffer.length);
      this._buffer = this._buffer.subarray(take);
      left -= take;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 解包路径安全                                                        */
/* ------------------------------------------------------------------ */

/**
 * 校验归档条目路径并归一化（去掉 './'、空段与目录结尾斜杠，统一为 '/' 分隔）。
 * 不安全路径一律抛中文 Error。
 */
function sanitizeArchivePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('拒绝解包：归档条目路径为空');
  }
  if (rawPath.includes('\0')) {
    throw new Error(`拒绝解包：归档条目路径包含 NUL 字符（${JSON.stringify(rawPath)}）`);
  }
  if (rawPath.startsWith('/') || rawPath.startsWith('\\') || /^[A-Za-z]:/.test(rawPath)) {
    throw new Error(`拒绝解包：归档包含绝对路径（${rawPath}）`);
  }
  const segments = rawPath.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new Error(`拒绝解包：归档路径包含越界路径段 ".."（${rawPath}）`);
  }
  return segments.filter((segment) => segment !== '' && segment !== '.').join('/');
}

/** 校验并解析出目标绝对路径，确保不逃出 destRoot。 */
function resolveSafeTarget(cleanRelPath, destRoot, rawPath) {
  const target = path.resolve(destRoot, cleanRelPath);
  if (target !== destRoot && !target.startsWith(destRoot + path.sep)) {
    throw new Error(`拒绝解包：归档路径解析后逃逸出目标目录（${rawPath}）`);
  }
  return target;
}

/**
 * 逐级确保目录存在。
 * - 已有目录：直接复用；
 * - 已有符号链接/普通文件：父级一律拒绝（安全）；最后一层在 allowReplaceLast 时先删后建；
 * - 不存在：mkdir。
 * 返回最后一层的绝对路径。
 */
async function ensureDirectorySegments(segments, destRoot, { allowReplaceLast = false } = {}) {
  let current = destRoot;
  for (let i = 0; i < segments.length; i += 1) {
    const isLast = i === segments.length - 1;
    current = path.join(current, segments[i]);
    const stat = await lstatOrNull(current);
    if (!stat) {
      await fsp.mkdir(current, { mode: 0o755 });
      continue;
    }
    if (stat.isDirectory()) continue;
    if (allowReplaceLast && isLast) {
      // 目录条目要覆盖已存在的文件/符号链接：先删后建（符号链接先删后建）
      await fsp.unlink(current);
      await fsp.mkdir(current, { mode: 0o755 });
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`拒绝解包：路径的父级是符号链接（${current}）`);
    }
    throw new Error(`拒绝解包：路径的父级不是目录（${current}）`);
  }
  return current;
}

/** 文件目标：已存在目录则报错，其余（文件/符号链接）先删，避免顺着符号链接写出 destDir。 */
async function prepareFileTarget(target, cleanRelPath) {
  const stat = await lstatOrNull(target);
  if (!stat) return;
  if (stat.isDirectory()) {
    throw new Error(`拒绝解包：目标路径已存在同名目录，无法覆盖为文件（${cleanRelPath}）`);
  }
  await fsp.unlink(target);
}

/** 符号链接目标：已存在的文件/符号链接直接删，目录仅允许空目录 rmdir。 */
async function prepareSymlinkTarget(target, cleanRelPath) {
  const stat = await lstatOrNull(target);
  if (!stat) return;
  if (stat.isDirectory()) {
    try {
      await fsp.rmdir(target);
    } catch {
      throw new Error(`拒绝解包：无法用符号链接覆盖非空目录（${cleanRelPath}）`);
    }
    return;
  }
  await fsp.unlink(target);
}

/* ------------------------------------------------------------------ */
/* 导出：formatBytes / sha256File                                      */
/* ------------------------------------------------------------------ */

/**
 * 1024 进制自适应格式化：0..1023 -> "512 B"；1.5*1024^2 -> "1.5 MB"；2*1024^3 -> "2 GB"。
 * @param {number} n 字节数
 * @returns {string}
 */
export function formatBytes(n) {
  const value = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  let unitIndex = 0;
  let scaled = value;
  while (scaled >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${Math.round(scaled)} B`;
  // toFixed(1) 后可能进位到 1024（例如 1048575 字节），此时升一级单位
  if (Number(scaled.toFixed(1)) >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const text = scaled.toFixed(1).replace(/\.0$/, '');
  return `${text} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * 文件 sha256（hex，小写），流式计算，大文件也不占内存。
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function sha256File(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('sha256File 需要文件路径');
  }
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

/* ------------------------------------------------------------------ */
/* 导出：packDirectoryBrotli                                           */
/* ------------------------------------------------------------------ */

/**
 * 递归打包目录为 tar 流 + Brotli(Q11) 压缩，原子落盘（先写 .tmp 再 rename）。
 * 保留：普通文件、目录、符号链接（tar type 2）、可执行位；保留 mtime。
 * 长路径（>100 字节）与中文路径用 PAX 扩展头（type 'x'）编码。
 *
 * @param {object} options
 * @param {string} options.sourceDir 要打包的目录（其内容作为 tar 根）
 * @param {string} options.outFile   输出 .tar.br 路径
 * @param {AbortSignal} [options.signal]
 * @param {(progress: {phase: string, done: number, total: number, percent: number}) => void} [options.onProgress]
 * @param {string[]} [options.exclude] 绝对路径前缀数组（命中的文件/目录整棵跳过）
 * @returns {Promise<{outFile: string, bytes: number, rawBytes: number, ratio: number,
 *   files: number, dirs: number, symlinks: number, durationMs: number}>}
 *   ratio = bytes / rawBytes（压缩后 / 压缩前 tar 流字节数）
 */
export async function packDirectoryBrotli(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('packDirectoryBrotli 需要一个选项对象');
  }
  const { sourceDir, outFile, signal, onProgress, exclude } = options;
  if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
    throw new TypeError('packDirectoryBrotli: 缺少 sourceDir');
  }
  if (typeof outFile !== 'string' || outFile.length === 0) {
    throw new TypeError('packDirectoryBrotli: 缺少 outFile');
  }
  throwIfAborted(signal);

  const startedAt = Date.now();
  const root = path.resolve(sourceDir);
  const outPath = path.resolve(outFile);
  const tmpPath = `${outPath}.tmp`;

  let rootStat;
  try {
    rootStat = await fsp.stat(root);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`打包失败：源目录不存在（${root}）`);
    throw err;
  }
  if (!rootStat.isDirectory()) throw new Error(`打包失败：sourceDir 不是目录（${root}）`);

  const excludes = normalizeExcludes(exclude);
  const skipPaths = new Set([outPath, tmpPath]);
  const entries = await collectEntries(root, { excludes, signal, skipPaths });
  const sizeHint = estimateTarBytes(entries);

  const counts = { files: 0, dirs: 0, symlinks: 0 };
  for (const entry of entries) {
    if (entry.type === 'file') counts.files += 1;
    else if (entry.type === 'dir') counts.dirs += 1;
    else counts.symlinks += 1;
  }

  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  const fileStream = createWriteStream(tmpPath);
  const compressor = createCompressor(sizeHint);
  const fileDone = finished(fileStream);
  const fileDoneSilenced = fileDone.catch(() => {});
  compressor.on('error', (err) => fileStream.destroy(err));
  fileStream.on('error', (err) => compressor.destroy(err));
  compressor.pipe(fileStream);

  const progress = createProgressReporter(onProgress, {
    phase: 'pack',
    total: entries.length,
    percent: (done) => (entries.length > 0 ? (done / entries.length) * 100 : 0),
  });

  let rawBytes = 0;
  try {
    for (let index = 0; index < entries.length; index += 1) {
      throwIfAborted(signal);
      const entry = entries[index];
      const plan = planEntry(entry);

      // PAX 扩展头（含数据区及 512 对齐填充）
      if (plan.paxData) {
        const paxHeader = buildTarHeader({
          name: '././@PaxHeader',
          mode: 0o644,
          size: plan.paxData.length,
          mtime: Math.max(0, Math.floor(entry.mtimeMs / 1000)),
          typeflag: 'x',
        });
        await writeToStream(compressor, paxHeader);
        rawBytes += BLOCK_SIZE;
        await writeToStream(compressor, plan.paxData);
        const paxPad = paddedLength(plan.paxData.length) - plan.paxData.length;
        if (paxPad > 0) await writeToStream(compressor, ZERO_BLOCK.subarray(0, paxPad));
        rawBytes += paddedLength(plan.paxData.length);
      }

      await writeToStream(compressor, plan.header);
      rawBytes += BLOCK_SIZE;

      if (entry.type === 'file') {
        let sent = 0;
        const readStream = createReadStream(entry.abs);
        try {
          for await (const chunk of readStream) {
            throwIfAborted(signal);
            let piece = chunk;
            if (sent + piece.length > plan.size) {
              piece = piece.subarray(0, plan.size - sent);
            }
            if (piece.length > 0) {
              await writeToStream(compressor, piece);
              sent += piece.length;
            }
            if (sent >= plan.size) break;
          }
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            throw new Error(`打包失败：文件在扫描后消失（${entry.rel}）`);
          }
          throw err;
        } finally {
          readStream.destroy();
        }
        if (sent < plan.size) {
          // 扫描后文件被截短：补零让 tar 头里的 size 与数据一致（校验 sha256 会暴露内容变化）
          await writeZeros(compressor, plan.size - sent);
        }
        // 文件数据区也要按 512 字节对齐，否则后续头会错位
        const filePad = paddedLength(plan.size) - plan.size;
        if (filePad > 0) await writeToStream(compressor, ZERO_BLOCK.subarray(0, filePad));
        rawBytes += paddedLength(plan.size);
      }

      progress.update(index + 1, rawBytes);
    }

    rawBytes += BLOCK_SIZE * 2;
    await writeToStream(compressor, ZERO_BLOCK);
    await writeToStream(compressor, ZERO_BLOCK);
    compressor.end();
    await fileDone;
  } catch (err) {
    try {
      compressor.destroy();
    } catch {
      /* 忽略 */
    }
    try {
      fileStream.destroy();
    } catch {
      /* 忽略 */
    }
    await fileDoneSilenced;
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }

  await fsp.rename(tmpPath, outPath);
  const outStat = await fsp.stat(outPath);
  const bytes = outStat.size;
  const ratio = rawBytes > 0 ? bytes / rawBytes : 0;
  progress.finish(entries.length, rawBytes);

  return {
    outFile: outPath,
    bytes,
    rawBytes,
    ratio,
    files: counts.files,
    dirs: counts.dirs,
    symlinks: counts.symlinks,
    durationMs: Date.now() - startedAt,
  };
}

/* ------------------------------------------------------------------ */
/* 解包共用：读条目头（含 PAX/GNU 扩展头）                             */
/* ------------------------------------------------------------------ */

const MAX_GNU_LONG_HEADER = 1024 * 1024;

/** 从 tar 头里读取一条条目（自动处理上一轮 PAX/GNU 扩展头、ustar prefix）。 */
function decodeTarHeader(block, paxRecords, gnuLongName, gnuLongLink) {
  const typeByte = block[156];
  const typeflag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
  const headerName = readFieldString(block, 0, 100);
  const prefix = readFieldString(block, 345, 155);
  const linkname = readFieldString(block, 157, 100);
  const records = paxRecords || Object.create(null);

  let name = records.path !== undefined ? records.path : headerName;
  if (records.path === undefined && gnuLongName) name = gnuLongName;
  if (records.path === undefined && !gnuLongName && prefix && !name.includes('/')) {
    name = `${prefix}/${name}`;
  }
  let linkTarget = records.linkpath !== undefined ? records.linkpath : linkname;
  if (records.linkpath === undefined && gnuLongLink) linkTarget = gnuLongLink;

  let size = readFieldOctal(block, 124, 12);
  if (records.size !== undefined) {
    const parsed = Number(records.size);
    if (Number.isSafeInteger(parsed) && parsed >= 0) size = parsed;
  }
  let mtimeSeconds = readFieldOctal(block, 136, 12);
  if (records.mtime !== undefined) {
    const parsed = Number(records.mtime);
    if (Number.isFinite(parsed)) mtimeSeconds = parsed;
  }
  let mode = readFieldOctal(block, 100, 8);
  if (records.mode !== undefined) {
    const parsed = Number.parseInt(records.mode, 8);
    if (Number.isFinite(parsed)) mode = parsed;
  }

  return { typeflag, name, linkTarget, size, mtimeSeconds, mode };
}

/** 处理扩展头（'x'/'g'/'L'/'K'），返回是否需要 continue。 */
async function consumeExtendedHeader(reader, typeflag, size, state) {
  if (typeflag !== 'x' && typeflag !== 'g' && typeflag !== 'L' && typeflag !== 'K') return false;
  const limit = typeflag === 'x' || typeflag === 'g' ? PAX_SIZE_LIMIT : MAX_GNU_LONG_HEADER;
  if (size > limit) throw new Error(`拒绝读取：扩展头过大（${size} 字节）`);
  const data = size > 0 ? await reader.readExactly(size) : Buffer.alloc(0);
  const pad = paddedLength(size) - size;
  if (pad > 0) await reader.skip(pad);
  if (typeflag === 'x') {
    state.pax = parsePaxRecords(data);
    state.gnuLongName = null;
    state.gnuLongLink = null;
  } else if (typeflag === 'g') {
    state.globalPax = { ...(state.globalPax || {}), ...parsePaxRecords(data) };
  } else if (typeflag === 'L') {
    state.gnuLongName = data.toString('utf8').replace(/\0+$/, '');
  } else {
    state.gnuLongLink = data.toString('utf8').replace(/\0+$/, '');
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 导出：extractArchive                                               */
/* ------------------------------------------------------------------ */

/** 解包权限兜底：Windows tar 的目录/文件常为 0666（无 exec 位），
 *  在 POSIX 上会导致目录不可遍历、文件不可读；这里补足基本权限。 */
function safeExtractMode(mode, isDir) {
  let m = Number(mode) & 0o7777;
  if ((m & 0o444) === 0) m |= 0o444;
  if (isDir && (m & 0o111) === 0) m |= 0o111;
  return m;
}

/** symlinkPolicy=copy 或 auto 降级时的复制逻辑。
 *  目标（linkTarget）在归档内已解包则复制其内容，否则跳过并 warning。 */
async function handleSymlinkCopy({ target, cleanRelPath, linkTarget, decoded, segments, destRoot, warnings, result }) {
  // 解析 linkTarget 是否指向 destDir 下已有条目
  const resolvedTarget = path.resolve(path.dirname(target), linkTarget);
  // 安全检查：必须在 destRoot 内
  if (resolvedTarget !== destRoot && !resolvedTarget.startsWith(destRoot + path.sep)) {
    warnings.push(`符号链接目标在解包目录外，跳过复制：${cleanRelPath} → ${linkTarget}`);
    result.entries.push({ path: cleanRelPath, type: 'symlink', size: 0 });
    return;
  }
  const targetStat = await lstatOrNull(resolvedTarget);
  if (!targetStat) {
    warnings.push(`符号链接目标未解包，跳过复制：${cleanRelPath} → ${linkTarget}`);
    result.entries.push({ path: cleanRelPath, type: 'symlink', size: 0 });
    return;
  }
  if (targetStat.isFile()) {
    await prepareFileTarget(target, cleanRelPath);
    await fsp.copyFile(resolvedTarget, target);
    try {
      await fsp.chmod(target, safeExtractMode(decoded.mode, false));
    } catch { /* 忽略 */ }
    try {
      if (Number.isFinite(decoded.mtimeSeconds) && decoded.mtimeSeconds >= 0) {
        await fsp.utimes(target, decoded.mtimeSeconds, decoded.mtimeSeconds);
      }
    } catch { /* 忽略 */ }
    result.files += 1;
    result.entries.push({ path: cleanRelPath, type: 'file', size: targetStat.size });
  } else if (targetStat.isDirectory()) {
    await prepareFileTarget(target, cleanRelPath);
    await fsp.cp(resolvedTarget, target, { recursive: true });
    try {
      if (Number.isFinite(decoded.mtimeSeconds) && decoded.mtimeSeconds >= 0) {
        await fsp.utimes(target, decoded.mtimeSeconds, decoded.mtimeSeconds);
      }
    } catch { /* 忽略 */ }
    result.dirs += 1;
    result.entries.push({ path: cleanRelPath, type: 'dir', size: 0 });
  } else {
    warnings.push(`符号链接目标类型不支持复制（${cleanRelPath} → ${linkTarget}）`);
    result.entries.push({ path: cleanRelPath, type: 'symlink', size: 0 });
  }
}

/**
 * 解包到 destDir。安全第一：
 *  - 拒绝绝对路径、含 `..` 的路径、解析后逃出 destDir 的路径（抛 Error，中文消息）
 *  - 支持 PAX 长路径 / 中文路径 / 符号链接 / 目录
 *  - 已存在文件直接覆盖；符号链接先删后建
 *
 * @param {object} options
 * @param {string} options.archiveFile .tar.br 归档路径
 * @param {string} options.destDir     解包目标目录
 * @param {AbortSignal} [options.signal]
 * @param {(progress: {phase: string, done: number, total: number, percent: number}) => void} [options.onProgress]
 * @param {'auto'|'copy'|'skip'} [options.symlinkPolicy='auto'] 符号链接策略：
 *   - auto：先尝试建 symlink，失败（EPERM/EACCES/UNKNOWN/不支持）时降级——目标在归档内且是文件则复制内容，目录可递归复制，否则 skip 并 warning；
 *   - copy：直接复制目标内容（不解引用符号链接），无法复制则 skip；
 *   - skip：跳过所有符号链接条目。
 * @returns {Promise<{files: number, dirs: number, symlinks: number,
 *   entries: Array<{path: string, type: 'file'|'dir'|'symlink', size: number}>,
 *   warnings: string[]}>}
 */
export async function extractArchive(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('extractArchive 需要一个选项对象');
  }
  const { archiveFile, destDir, signal, onProgress } = options;
  const symlinkPolicy = ['auto', 'copy', 'skip'].includes(options.symlinkPolicy)
    ? options.symlinkPolicy
    : 'auto';
  if (typeof archiveFile !== 'string' || archiveFile.length === 0) {
    throw new TypeError('extractArchive: 缺少 archiveFile');
  }
  if (typeof destDir !== 'string' || destDir.length === 0) {
    throw new TypeError('extractArchive: 缺少 destDir');
  }
  throwIfAborted(signal);

  const destRoot = path.resolve(destDir);
  await fsp.mkdir(destRoot, { recursive: true });
  const archiveStat = await fsp.stat(archiveFile);
  const archiveBytes = archiveStat.size;

  const archive = openBrotliReader(archiveFile);
  const reader = new TarReader(archive.stream);
  const state = { pax: null, globalPax: null, gnuLongName: null, gnuLongLink: null };
  const dirTimes = []; // 目录的 mode/mtime 要等子项写完再恢复，否则会被改写
  const warnings = []; // symlink 降级/跳过时记录
  const pendingSymlinkCopies = []; // copy/auto 降级：等全部条目解包完再复制（目标可能后出现）
  const result = { files: 0, dirs: 0, symlinks: 0, entries: [], warnings };
  let entriesDone = 0; // 进度用的 done = 已处理条目数（不是 chunk 数）

  const progress = createProgressReporter(onProgress, {
    phase: 'extract',
    total: archiveBytes,
    percent: (done, bytes) => (archiveBytes > 0 ? (bytes / archiveBytes) * 100 : 0),
  });

  try {
    for (;;) {
      throwIfAborted(signal);
      const block = await reader.readBlock();
      if (!block || isZeroBlock(block)) break;

      const typeByte = block[156];
      const typeflag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
      const rawSize = readFieldOctal(block, 124, 12);

      if (await consumeExtendedHeader(reader, typeflag, rawSize, state)) continue;

      const effectivePax = { ...(state.globalPax || {}), ...(state.pax || {}) };
      const gnuLongName = state.gnuLongName;
      const gnuLongLink = state.gnuLongLink;
      state.pax = null;
      state.gnuLongName = null;
      state.gnuLongLink = null;

      const decoded = decodeTarHeader(block, effectivePax, gnuLongName, gnuLongLink);
      let type;
      if (decoded.typeflag === '5') type = 'dir';
      else if (decoded.typeflag === '2') type = 'symlink';
      else if (
        decoded.typeflag === '0' ||
        decoded.typeflag === '7' ||
        decoded.typeflag === '\0'
      ) {
        type = 'file';
      } else {
        // 未支持的类型（硬链接/设备/fifo 等）：跳过数据区，不影响其它条目
        await reader.skip(paddedLength(decoded.size));
        continue;
      }

      const cleanRelPath = sanitizeArchivePath(decoded.name);
      if (cleanRelPath === '') {
        if (type === 'dir') {
          await reader.skip(paddedLength(decoded.size));
          continue; // 归档根的 './' 条目，忽略
        }
        throw new Error(`拒绝解包：归档条目路径为空（${decoded.name}）`);
      }
      const target = resolveSafeTarget(cleanRelPath, destRoot, decoded.name);
      const segments = cleanRelPath.split('/');

      if (type === 'dir') {
        await reader.skip(paddedLength(decoded.size));
        await ensureDirectorySegments(segments, destRoot, { allowReplaceLast: true });
        dirTimes.push({ target, mode: safeExtractMode(decoded.mode, true), mtime: decoded.mtimeSeconds });
        result.dirs += 1;
        result.entries.push({ path: cleanRelPath, type: 'dir', size: 0 });
      } else if (type === 'file') {
        const parentSegments = segments.slice(0, -1);
        await ensureDirectorySegments(parentSegments, destRoot);
        await prepareFileTarget(target, cleanRelPath);
        const handle = await fsp.open(target, 'w', safeExtractMode(decoded.mode, false));
        try {
          let remaining = decoded.size;
          while (remaining > 0) {
            throwIfAborted(signal);
            const chunk = await reader.readSome(remaining);
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
              if (bytesWritten <= 0) throw new Error(`写入文件失败（${cleanRelPath}）`);
              offset += bytesWritten;
            }
            remaining -= chunk.length;
            // 大文件搬运过程中 done 不变，靠已消费压缩字节推进进度
            progress.update(entriesDone, archive.compressedRead);
          }
          await handle.chmod(safeExtractMode(decoded.mode, false));
        } finally {
          await handle.close();
        }
        const padding = paddedLength(decoded.size) - decoded.size;
        if (padding > 0) await reader.skip(padding);
        // 恢复 mtime（atime 也用 mtime：归档里不保存 atime）
        try {
          if (Number.isFinite(decoded.mtimeSeconds) && decoded.mtimeSeconds >= 0) {
            await fsp.utimes(target, decoded.mtimeSeconds, decoded.mtimeSeconds);
          }
        } catch {
          // 某些文件系统不支持修改时间，忽略，不影响解包成功
        }
        result.files += 1;
        result.entries.push({ path: cleanRelPath, type: 'file', size: decoded.size });
      } else {
        // symbol link
        if (!decoded.linkTarget) throw new Error(`拒绝解包：符号链接条目缺少目标（${cleanRelPath}）`);
        const parentSegments = segments.slice(0, -1);
        await ensureDirectorySegments(parentSegments, destRoot);
        await reader.skip(paddedLength(decoded.size));

        if (symlinkPolicy === 'skip') {
          warnings.push(`符号链接已跳过（symlinkPolicy=skip）：${cleanRelPath} → ${decoded.linkTarget}`);
          result.entries.push({ path: cleanRelPath, type: 'symlink', size: 0 });
        } else if (symlinkPolicy === 'copy') {
          pendingSymlinkCopies.push({ target, cleanRelPath, linkTarget: decoded.linkTarget, decoded, segments, destRoot });
        } else {
          // auto：先尝试建 symlink，失败降级
          await prepareSymlinkTarget(target, cleanRelPath);
          try {
            await fsp.symlink(decoded.linkTarget, target);
            try {
              await fsp.lutimes(target, decoded.mtimeSeconds, decoded.mtimeSeconds);
            } catch {
              // 部分文件系统不支持 lutimes，忽略
            }
            result.symlinks += 1;
            result.entries.push({ path: cleanRelPath, type: 'symlink', size: 0 });
          } catch (symErr) {
            // 降级：EPERM / EACCES / ENOTSUP / EUNKNOWN / 不支持
            const code = String(symErr?.code || '').toUpperCase();
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'ENOSYS' || code === 'UNKNOWN' || code === 'ERR_INVALID_ARG_VALUE') {
              warnings.push(`符号链接降级（${code}）：${cleanRelPath} → ${decoded.linkTarget}`);
              pendingSymlinkCopies.push({ target, cleanRelPath, linkTarget: decoded.linkTarget, decoded, segments, destRoot });
            } else {
              throw symErr;
            }
          }
        }
      }

      entriesDone += 1;
      progress.update(entriesDone, archive.compressedRead);
    }

    // copy/auto 降级的符号链接：等所有条目（尤其目标文件）解包完再复制
    for (const item of pendingSymlinkCopies) {
      throwIfAborted(signal);
      await handleSymlinkCopy({ ...item, warnings, result });
    }

    // 目录的 mode/mtime 最后统一恢复（倒序：先深后浅）
    for (let i = dirTimes.length - 1; i >= 0; i -= 1) {
      const dir = dirTimes[i];
      try {
        await fsp.chmod(dir.target, dir.mode & 0o7777);
      } catch {
        /* 忽略 */
      }
      try {
        if (Number.isFinite(dir.mtime) && dir.mtime >= 0) {
          await fsp.utimes(dir.target, dir.mtime, dir.mtime);
        }
      } catch {
        /* 忽略 */
      }
    }
  } finally {
    archive.destroy();
  }

  progress.finish(entriesDone, archiveBytes);
  return result;
}

/* ------------------------------------------------------------------ */
/* 导出：listArchive                                                  */
/* ------------------------------------------------------------------ */

/**
 * 只读列出归档条目（用于 AI 预览，不解包）。最多返回 maxEntries 条。
 * mtime 为 ISO 8601 字符串；total 是归档里的条目总数（含被截断的）。
 *
 * @param {object} options
 * @param {string} options.archiveFile
 * @param {number} [options.maxEntries=500]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{entries: Array<{path: string, type: 'file'|'dir'|'symlink',
 *   size: number, mtime: string|null}>, total: number, truncated: boolean}>}
 */
export async function listArchive(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('listArchive 需要一个选项对象');
  }
  const { archiveFile, signal } = options;
  const rawMax = options.maxEntries === undefined ? 500 : options.maxEntries;
  const maxEntries = Number.isFinite(rawMax) ? Math.max(0, Math.floor(rawMax)) : 500;
  if (typeof archiveFile !== 'string' || archiveFile.length === 0) {
    throw new TypeError('listArchive: 缺少 archiveFile');
  }
  throwIfAborted(signal);

  const archive = openBrotliReader(archiveFile);
  const reader = new TarReader(archive.stream);
  const state = { pax: null, globalPax: null, gnuLongName: null, gnuLongLink: null };
  const entries = [];
  let total = 0;

  try {
    for (;;) {
      throwIfAborted(signal);
      const block = await reader.readBlock();
      if (!block || isZeroBlock(block)) break;

      const typeByte = block[156];
      const typeflag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
      const rawSize = readFieldOctal(block, 124, 12);
      if (await consumeExtendedHeader(reader, typeflag, rawSize, state)) continue;

      const effectivePax = { ...(state.globalPax || {}), ...(state.pax || {}) };
      const gnuLongName = state.gnuLongName;
      const gnuLongLink = state.gnuLongLink;
      state.pax = null;
      state.gnuLongName = null;
      state.gnuLongLink = null;

      const decoded = decodeTarHeader(block, effectivePax, gnuLongName, gnuLongLink);
      await reader.skip(paddedLength(decoded.size));

      let type;
      if (decoded.typeflag === '5') type = 'dir';
      else if (decoded.typeflag === '2') type = 'symlink';
      else if (
        decoded.typeflag === '0' ||
        decoded.typeflag === '7' ||
        decoded.typeflag === '\0'
      ) {
        type = 'file';
      } else {
        continue; // 设备/硬链接等不列入预览
      }

      // 预览只读：这里不做安全校验抛错，保留原始路径给调用方看（解包时仍会严格校验）
      const cleanName = decoded.name.replace(/\/+$/, '');
      total += 1;
      if (entries.length < maxEntries) {
        const mtimeMs = decoded.mtimeSeconds * 1000;
        entries.push({
          path: cleanName,
          type,
          size: type === 'file' ? decoded.size : 0,
          mtime: Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : null,
        });
      }
    }
  } finally {
    archive.destroy();
  }

  return { entries, total, truncated: total > entries.length };
}
