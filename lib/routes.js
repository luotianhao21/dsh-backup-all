// dsh-backup-all · HTTP 路由
//
// 浏览器端（client.js）用同源 fetch 访问 /dsh-backup-all/*。
// 鉴权沿用 DSH 自己的 connection 判定（和 dsh-xingxi 等插件一致）：
//   const rejection = ctx.get('connection').requestRejection(req)
//   rejection !== undefined → 直接回状态码（401/403）。
//
// 约定：绝大多数操作返回 HTTP 200 + JSON {ok:false,error}，客户端只看 ok；
// 只有路由不存在才 404。这样前端不用为每种失败写 status 分支。

import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, statSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { publicAiSettings } from './store.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_IMPORT_BYTES = 512 * 1024 * 1024

function sendJson(res, value, status = 200) {
  let body
  try {
    body = JSON.stringify(value)
  } catch {
    body = '{"ok":false,"error":"响应序列化失败"}'
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function decodeHeader(value) {
  const raw = String(value || '')
  if (!raw) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 导入：原始字节流写入 backup/.cache，然后交给 runtime.importSnapshot 校验/登记 */
function handleImport(req, res, runtime) {
  const env = runtime && runtime.env ? runtime.env : {}
  const backupDir = env.backupDir
  const cacheDir = env.cacheDir
  if (!backupDir || !cacheDir) {
    sendJson(res, { ok: false, error: '运行环境缺少 backup 目录' })
    return
  }
  const declared = Number(req.headers['content-length'] || 0)
  if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
    sendJson(res, { ok: false, error: '快照文件过大（上限 512 MiB）' })
    try { req.resume() } catch {}
    return
  }
  try { mkdirSync(cacheDir, { recursive: true }) } catch {}
  const tempFile = join(cacheDir, 'import-' + randomUUID() + '.bin')
  const out = createWriteStream(tempFile)
  let size = 0
  let aborted = false
  const cleanup = () => {
    try { if (existsSync(tempFile)) rmSync(tempFile, { force: true }) } catch {}
  }
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_IMPORT_BYTES && !aborted) {
      aborted = true
      try { req.destroy() } catch {}
      try { out.destroy() } catch {}
      cleanup()
      sendJson(res, { ok: false, error: '快照文件过大（上限 512 MiB）' })
    }
  })
  req.on('error', () => {
    if (aborted) return
    aborted = true
    cleanup()
    try { sendJson(res, { ok: false, error: '上传中断' }) } catch {}
  })
  out.on('error', () => {
    if (aborted) return
    aborted = true
    cleanup()
    try { sendJson(res, { ok: false, error: '写入临时文件失败' }) } catch {}
  })
  out.on('finish', async () => {
    if (aborted) return
    try {
      const result = await runtime.importSnapshot({
        tempFile,
        originalFilename: decodeHeader(req.headers['x-snapshot-filename']),
        name: decodeHeader(req.headers['x-snapshot-name']),
        description: decodeHeader(req.headers['x-snapshot-description']),
      })
      sendJson(res, result)
    } catch (error) {
      cleanup()
      sendJson(res, { ok: false, error: String((error && error.message) || error) })
    }
  })
  req.pipe(out)
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export function registerRoutes(ctx, runtime) {
  const handler = async (req, res) => {
    // 1) 鉴权（fail-closed：拿不到 connection 服务就拒绝，绝不静默放行）
    let connection
    try {
      connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    } catch {
      connection = undefined
    }
    if (!connection || typeof connection.requestRejection !== 'function') {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('auth service unavailable')
      return
    }
    try {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
    } catch {
      // 鉴权服务异常时宁可拒绝也不放行
      res.writeHead(403)
      res.end('forbidden')
      return
    }

    // 2) 解析路径
    let pathname = '/'
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      pathname = decodeURIComponent(url.pathname)
      if (!pathname.startsWith('/dsh-backup-all')) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      pathname = pathname.slice('/dsh-backup-all'.length) || '/'
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1)
    } catch {
      sendJson(res, { ok: false, error: '无效的请求路径' })
      return
    }

    const method = String(req.method || 'GET').toUpperCase()
    const query = (() => {
      try {
        return new URL(req.url || '/', 'http://127.0.0.1').searchParams
      } catch {
        return new URLSearchParams()
      }
    })()

    try {
      // 3) GET
      if (method === 'GET') {
        if (pathname === '/snapshot/export') {
          const info = runtime.getExportInfo({ id: query.get('id') || '' })
          if (!info || info.ok !== true) {
            return sendJson(res, info || { ok: false, error: '找不到该快照' }, 404)
          }
          let size = 0
          try { size = statSync(info.path).size } catch {}
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(info.file),
            'content-length': size,
            'cache-control': 'no-store',
          })
          const stream = createReadStream(info.path)
          stream.on('error', () => { try { res.destroy() } catch {} })
          stream.pipe(res)
          return
        }
        if (pathname === '/state') return sendJson(res, runtime.getState())
        if (pathname === '/log') {
          return sendJson(
            res,
            runtime.getLog({
              since: Number(query.get('since') || 0),
              runId: query.get('runId') || '',
            }),
          )
        }
        if (pathname === '/settings') {
          return sendJson(res, {
            ok: true,
            settings: {
              ai: publicAiSettings(runtime.getAiSettings()),
              snapshot: runtime.getSnapshotSettings ? runtime.getSnapshotSettings() : {},
            },
          })
        }
        if (pathname === '/version') return sendJson(res, { ok: true, version: runtime.version })
        res.writeHead(404)
        res.end('not found')
        return
      }

      // 4) POST
      if (method !== 'POST') {
        res.writeHead(405)
        res.end('method not allowed')
        return
      }
      if (pathname === '/snapshot/import') {
        handleImport(req, res, runtime)
        return
      }
      const body = await readJsonBody(req)

      switch (pathname) {
        case '/snapshot/create':
          return sendJson(res, await runtime.startSnapshot({ name: body.name, description: body.description }))
        case '/snapshot/abort':
          return sendJson(res, runtime.abortRun({ runId: body.runId }))
        case '/snapshot/edit':
          return sendJson(res, runtime.editRecord({ id: body.id, name: body.name, description: body.description }))
        case '/snapshot/archive':
          return sendJson(res, runtime.setArchived({ id: body.id, archived: body.archived }))
        case '/snapshot/delete':
          return sendJson(res, runtime.deleteRecord({ id: body.id }))
        case '/snapshot/promote':
          return sendJson(res, runtime.promoteRecord({ id: body.id, name: body.name, description: body.description }))
        case '/restore/start':
          return sendJson(res, await runtime.startRestore({ id: body.id }))
        case '/restore/abort':
          return sendJson(res, runtime.abortRun({ runId: body.runId }))
        case '/settings':
          return sendJson(res, runtime.saveSettings(body))
        case '/settings/test':
          return sendJson(res, await runtime.testSettings(body))
        case '/clear':
          return sendJson(res, runtime.clearAll({ confirm: body.confirm === true }))
        default:
          res.writeHead(404)
          res.end('not found')
          return
      }
    } catch (error) {
      try {
        sendJson(res, { ok: false, error: String((error && error.message) || error) })
      } catch {
        try {
          res.writeHead(500)
          res.end('internal error')
        } catch {}
      }
    }
  }

  return ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-backup-all',
        handler,
      }),
    'dsh-backup-all: http routes',
  )
}
