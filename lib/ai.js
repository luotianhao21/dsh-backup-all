// dsh-backup-all · 独立 AI 客户端 + 迷你 agent loop
//
// 为什么不用 DSH 自己的 llm 服务：
//   用户在高级设置里要求「单独配置一个 AI 模型」（Base URL / 协议 / Key / Model / 上下文 / 最大输出 / Effort），
//   和当前会话模型无关。所以这里直接按 OpenAI Chat Completions 或 Anthropic Messages 协议发请求，
//   自己实现流式解析 + tool calling + 中断。零第三方依赖。
//
// 对外：
//   createAiClient(aiConfig)                 → { config, streamChat(), testConnection() }
//   runToolLoop({ client, system, user, tools, signal, onEvent, options })
//   testAiConnection(aiConfig)               → { ok, latencyMs, detail, error }
//   AiAbortError                             中断信号专用错误

export class AiError extends Error {
  constructor(message, extra = {}) {
    super(message)
    this.name = 'AiError'
    this.status = extra.status
    this.body = extra.body
    this.kind = extra.kind || 'error'
  }
}

export class AiAbortError extends AiError {
  constructor(message = '已中断') {
    super(message, { kind: 'aborted' })
    this.name = 'AiAbortError'
  }
}

const DEFAULT_TIMEOUT_MS = 180_000
const ANTHROPIC_VERSION = '2023-06-01'

function stripTrailingSlash(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

/** 根据协议把用户填的 Base URL 规范成具体端点 */
export function resolveEndpoints(ai) {
  const protocol = ai.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions'
  let base = stripTrailingSlash(ai.baseURL)
  if (!base) return { protocol, chatUrl: '', modelsUrl: '' }
  if (protocol === 'openai-completions') {
    let root = base
    if (/\/chat\/completions$/.test(root)) root = root.replace(/\/chat\/completions$/, '')
    return {
      protocol,
      chatUrl: /\/chat\/completions$/.test(base) ? base : root + '/chat/completions',
      modelsUrl: root + '/models',
    }
  }
  let root = base
  if (/\/messages$/.test(root)) root = root.replace(/\/messages$/, '')
  return {
    protocol,
    chatUrl: /\/messages$/.test(base) ? base : (/\/v1$/.test(root) ? root + '/messages' : root + '/v1/messages'),
    modelsUrl: /\/v1$/.test(root) ? root + '/models' : root + '/v1/models',
  }
}

function authHeaders(protocol, apiKey) {
  if (protocol === 'anthropic-messages') {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    }
  }
  return {
    'content-type': 'application/json',
    authorization: 'Bearer ' + apiKey,
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function truncate(text, max) {
  const s = String(text == null ? '' : text)
  return s.length <= max ? s : s.slice(0, max) + '\n…[已截断，原长 ' + s.length + ' 字符]'
}

/** 把内部消息翻译成 OpenAI Chat Completions 的 messages */
function toOpenAiMessages(system, messages) {
  const out = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: String(m.content == null ? '' : m.content) })
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' }
      if (m.toolCalls && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.arguments || {}) },
        }))
        if (!msg.content) delete msg.content
      }
      out.push(msg)
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content == null ? '' : m.content) })
    } else {
      out.push({ role: 'user', content: String(m.content == null ? '' : m.content) })
    }
  }
  return out
}

/** 把内部消息翻译成 Anthropic Messages 的 messages（tool_result 要包进 user） */
function toAnthropicMessages(messages) {
  const out = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      const blocks = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const t of m.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.arguments || {} })
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' })
      out.push({ role: 'assistant', content: blocks })
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content == null ? '' : m.content) }],
      })
    } else {
      out.push({ role: 'user', content: [{ type: 'text', text: String(m.content == null ? '' : m.content) }] })
    }
  }
  return out
}

function openAiTools(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } },
  }))
}

function anthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    input_schema: t.parameters || { type: 'object', properties: {} },
  }))
}

/** 逐块读取 SSE，按 data 行回调；兼容 [DONE] 与行内多事件。 */
async function readSse(response, signal, onData) {
  if (!response.body) throw new AiError('响应没有可读的 body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) throw new AiAbortError()
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        if (data === '[DONE]') {
          onData({ done: true })
          continue
        }
        const json = safeJson(data)
        if (json) onData({ json })
      }
    }
    if (buffer.trim()) {
      const line = buffer.trim()
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim()
        if (data && data !== '[DONE]') {
          const json = safeJson(data)
          if (json) onData({ json })
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}

/**
 * 网络抖动重试：模型流式请求在「还没拿到响应头」之前失败（fetch failed / ECONNRESET / 5xx）时重试。
 * 已经开始的流不重试（否则会重复输出）。最多 3 次，退避 1s / 3s。
 */
async function postWithRetry(url, init, signal) {
  let lastError = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal && signal.aborted) throw new AiAbortError()
    try {
      const response = await fetch(url, init)
      // 5xx/429 视为可重试的服务端抖动
      if ((response.status >= 500 || response.status === 429) && attempt < 3) {
        lastError = new AiError('服务端临时错误 HTTP ' + response.status, { status: response.status })
        try {
          await response.text()
        } catch {}
        await new Promise((r) => setTimeout(r, attempt * 1000))
        continue
      }
      return response
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.kind === 'aborted')) throw new AiAbortError()
      lastError = error
      if (attempt < 3) {
        // fetch failed / socket 中断：等一会儿再试
        await new Promise((r) => setTimeout(r, attempt * 1000))
        continue
      }
      throw new AiError('模型请求失败（网络）：' + String((error && error.message) || error) + '，已重试 3 次', { kind: 'network' })
    }
  }
  throw lastError instanceof Error ? lastError : new AiError('模型请求失败')
}

function collectErrorBody(status, text) {
  return 'HTTP ' + status + (text ? '：' + truncate(String(text).replace(/\s+/g, ' '), 500) : '')
}

export function createAiClient(aiConfig) {
  const ai = {
    baseURL: String(aiConfig?.baseURL || ''),
    protocol: aiConfig?.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
    apiKey: String(aiConfig?.apiKey || ''),
    modelId: String(aiConfig?.modelId || ''),
    maxOutput: Math.max(256, Math.min(1_000_000, Number(aiConfig?.maxOutput) || 32768)),
    effort: String(aiConfig?.effort || 'max'),
    contextWindow: Math.max(4096, Number(aiConfig?.contextWindow) || 256000),
  }
  const endpoints = resolveEndpoints(ai)
  if (!endpoints.chatUrl) throw new AiError('AI 配置不完整：缺少 API Base URL')
  if (!ai.modelId) throw new AiError('AI 配置不完整：缺少 AI Model ID')
  if (!ai.apiKey) throw new AiError('AI 配置不完整：缺少 API Key')

  /**
   * 一次模型调用（流式）。
   * @returns {Promise<{text, reasoning, toolCalls:[{id,name,arguments}], finishReason, usage}>}
   */
  async function streamChat({ messages, tools, signal, onDelta }) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) throw new AiAbortError()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(new Error('timeout')), DEFAULT_TIMEOUT_MS)
    const emit = (event) => {
      try {
        onDelta && onDelta(event)
      } catch {}
    }
    try {
      if (endpoints.protocol === 'anthropic-messages') {
        return await streamAnthropic({ messages, tools, signal: controller.signal, emit })
      }
      return await streamOpenAi({ messages, tools, signal: controller.signal, emit })
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.kind === 'aborted')) throw new AiAbortError()
      if (error && error.message === 'timeout') throw new AiError('模型请求超时（' + Math.round(DEFAULT_TIMEOUT_MS / 1000) + ' 秒）', { kind: 'timeout' })
      throw error instanceof AiError ? error : new AiError('模型请求失败：' + String((error && error.message) || error))
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }

  async function streamOpenAi({ messages, tools, signal, emit }) {
    const body = {
      model: ai.modelId,
      messages: toOpenAiMessages(undefined, messages),
      stream: true,
      max_tokens: ai.maxOutput,
    }
    if (tools && tools.length) {
      body.tools = openAiTools(tools)
      body.tool_choice = 'auto'
    }
    if (ai.effort && ai.effort !== 'off') body.reasoning_effort = ai.effort
    let response = await postWithRetry(endpoints.chatUrl, {
      method: 'POST',
      headers: authHeaders('openai-completions', ai.apiKey),
      body: JSON.stringify(body),
      signal,
    }, signal)
    let text400 = ''
    if (!response.ok && (response.status === 400 || response.status === 422)) {
      // 有些 OpenAI 兼容上游不认 reasoning_effort / max_tokens，降级重试一次
      text400 = await response.text().catch(() => '')
      const retryBody = { ...body }
      delete retryBody.reasoning_effort
      if (/max_tokens/i.test(text400) && /stream_options|max_completion_tokens/i.test(text400)) delete retryBody.max_tokens
      response = await fetch(endpoints.chatUrl, {
        method: 'POST',
        headers: authHeaders('openai-completions', ai.apiKey),
        body: JSON.stringify(retryBody),
        signal,
      })
    }
    if (!response.ok) {
      const text = text400 || (await response.text().catch(() => ''))
      throw new AiError(collectErrorBody(response.status, text), { status: response.status, body: text })
    }
    const state = {
      text: '',
      reasoning: '',
      toolCalls: [],
      finishReason: '',
      usage: null,
    }
    const toolMap = new Map()
    await readSse(response, signal, ({ json, done }) => {
      if (done) return
      const choice = json.choices && json.choices[0]
      if (json.usage) state.usage = json.usage
      if (choice) {
        const delta = choice.delta || {}
        if (typeof delta.content === 'string' && delta.content) {
          state.text += delta.content
          emit({ type: 'text', text: delta.content })
        }
        const reasoning = delta.reasoning_content || delta.reasoning
        if (typeof reasoning === 'string' && reasoning) {
          state.reasoning += reasoning
          emit({ type: 'reasoning', text: reasoning })
        }
        for (const tc of delta.tool_calls || []) {
          const index = typeof tc.index === 'number' ? tc.index : toolMap.size
          let slot = toolMap.get(index)
          if (!slot) {
            slot = { id: tc.id || 'call_' + index + '_' + Date.now(), name: '', argumentsText: '' }
            toolMap.set(index, slot)
          }
          if (tc.id) slot.id = tc.id
          if (tc.function && tc.function.name) slot.name += tc.function.name
          if (tc.function && typeof tc.function.arguments === 'string') slot.argumentsText += tc.function.arguments
        }
        if (choice.finish_reason) state.finishReason = choice.finish_reason
      }
    })
    state.toolCalls = [...toolMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, slot]) => ({
        id: slot.id,
        name: slot.name,
        arguments: safeJson(slot.argumentsText) || {},
      }))
      .filter((t) => t.name)
    return state
  }

  async function streamAnthropic({ messages, tools, signal, emit }) {
    const systemMsg = messages.find((m) => m.role === 'system')
    const rest = messages.filter((m) => m.role !== 'system')
    const body = {
      model: ai.modelId,
      system: systemMsg ? String(systemMsg.content || '') : undefined,
      messages: toAnthropicMessages(rest),
      max_tokens: ai.maxOutput,
      stream: true,
    }
    if (tools && tools.length) body.tools = anthropicTools(tools)
    const response = await postWithRetry(endpoints.chatUrl, {
      method: 'POST',
      headers: authHeaders('anthropic-messages', ai.apiKey),
      body: JSON.stringify(body),
      signal,
    }, signal)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new AiError(collectErrorBody(response.status, text), { status: response.status, body: text })
    }
    const state = { text: '', reasoning: '', toolCalls: [], finishReason: '', usage: null }
    const blocks = new Map() // index -> {type, id, name, json}
    await readSse(response, signal, ({ json, done }) => {
      if (done) return
      switch (json.type) {
        case 'content_block_start': {
          const block = json.content_block || {}
          if (block.type === 'tool_use') {
            blocks.set(json.index, { type: 'tool_use', id: block.id, name: block.name, json: '' })
          } else if (block.type === 'thinking') {
            blocks.set(json.index, { type: 'thinking', text: '' })
          }
          break
        }
        case 'content_block_delta': {
          const delta = json.delta || {}
          if (delta.type === 'text_delta' && delta.text) {
            state.text += delta.text
            emit({ type: 'text', text: delta.text })
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            state.reasoning += delta.thinking
            emit({ type: 'reasoning', text: delta.thinking })
          } else if (delta.type === 'input_json_delta') {
            const slot = blocks.get(json.index)
            if (slot) slot.json += delta.partial_json || ''
          }
          break
        }
        case 'content_block_stop': {
          const slot = blocks.get(json.index)
          if (slot && slot.type === 'tool_use') {
            state.toolCalls.push({ id: slot.id, name: slot.name, arguments: safeJson(slot.json) || {} })
          }
          break
        }
        case 'message_delta': {
          if (json.delta && json.delta.stop_reason) state.finishReason = json.delta.stop_reason
          if (json.usage) state.usage = json.usage
          break
        }
        default:
          break
      }
    })
    return state
  }

  async function testConnection() {
    const started = Date.now()
    const attempts = []
    const headers = authHeaders(endpoints.protocol, ai.apiKey)
    try {
      const res = await fetch(endpoints.modelsUrl, { method: 'GET', headers, signal: AbortSignal.timeout(20_000) })
      attempts.push('GET /models HTTP ' + res.status)
      if (res.ok) {
        await res.text().catch(() => '')
        return { ok: true, latencyMs: Date.now() - started, detail: attempts.join('；') }
      }
    } catch (error) {
      attempts.push('GET /models 失败：' + String((error && error.message) || error))
    }
    // 模型列表不可用（不少兼容网关没实现）→ 用一次最小对话请求探活
    try {
      const body = endpoints.protocol === 'anthropic-messages'
        ? { model: ai.modelId, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }
        : { model: ai.modelId, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }
      const res = await fetch(endpoints.chatUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text().catch(() => '')
      attempts.push('POST 对话 HTTP ' + res.status)
      if (res.ok) return { ok: true, latencyMs: Date.now() - started, detail: attempts.join('；') }
      return { ok: false, latencyMs: Date.now() - started, detail: attempts.join('；'), error: collectErrorBody(res.status, text) }
    } catch (error) {
      attempts.push('POST 对话失败：' + String((error && error.message) || error))
      return { ok: false, latencyMs: Date.now() - started, detail: attempts.join('；'), error: String((error && error.message) || error) }
    }
  }

  return { config: ai, endpoints, streamChat, testConnection }
}

/** 独立测试入口（不构造 Chat 客户端也能测） */
export async function testAiConnection(aiConfig) {
  try {
    const client = createAiClient(aiConfig)
    return await client.testConnection()
  } catch (error) {
    return { ok: false, latencyMs: 0, error: String((error && error.message) || error), detail: '' }
  }
}

function estimateChars(messages) {
  let n = 0
  for (const m of messages) {
    n += String(m.content || '').length + String(m.toolCallId || '').length
    for (const t of m.toolCalls || []) n += JSON.stringify(t.arguments || {}).length + 64
  }
  return n
}

/**
 * 迷你 agent loop：模型 → 工具 → 模型 … 直到 ctx.finished 或达到上限。
 * @param {object} opts
 * @param {object} opts.client createAiClient 的返回值
 * @param {string} opts.system
 * @param {string} opts.user
 * @param {Array}  opts.tools  [{name, description, parameters, execute(args, ctx), summarize?}]
 * @param {AbortSignal} opts.signal
 * @param {(event)=>void} opts.onEvent  text/reasoning/tool-start/tool-result/log/error/warn
 * @param {object} [opts.options] { maxIterations=60, deadlineMs=20*60*1000, maxToolResultChars=24000, maxNudges=2, getFinished() }
 * @returns {Promise<{ok, aborted, finished, iterations, text, toolCalls, error}>}
 */
export async function runToolLoop({ client, system, user, tools, signal, onEvent, options = {} }) {
  const emit = (event) => {
    try {
      onEvent && onEvent(event)
    } catch {}
  }
  const maxIterations = Number(options.maxIterations) || 60
  const deadlineMs = Number(options.deadlineMs) || 20 * 60 * 1000
  const softDeadlineRatio = Number(options.softDeadlineRatio) > 0 ? Math.min(0.95, Number(options.softDeadlineRatio)) : 0.75
  const startedAt = Date.now()
  const deadline = startedAt + deadlineMs
  let softWarned = false
  const maxToolResultChars = Number(options.maxToolResultChars) || 24000
  const maxNudges = Number(options.maxNudges ?? 2)
  const getFinished = typeof options.getFinished === 'function' ? options.getFinished : () => false
  const contextCharsLimit = Math.max(200_000, Number(client.config.contextWindow) * 3)

  const messages = [{ role: 'user', content: user }]
  let nudges = 0
  let text = ''
  let iterations = 0
  const toolDefs = tools || []
  const toolByName = new Map(toolDefs.map((t) => [t.name, t]))

  const compact = () => {
    let total = estimateChars(messages)
    if (total <= contextCharsLimit) return
    // 从最老的 tool 结果开始换成占位，保留最近 12 条不动
    for (let i = 0; i < messages.length - 12 && total > contextCharsLimit; i++) {
      const m = messages[i]
      if (m.role === 'tool' && String(m.content || '').length > 400) {
        const original = String(m.content).length
        total -= original
        m.content = '[较早的工具 ' + String(m.name || 'unknown') + ' 的结果已为节省上下文而移除（原长 ' +
          original + ' 字符）；如仍需要请重新调用该工具]'
        total += String(m.content).length
      }
    }
    if (total > contextCharsLimit) {
      // 还超就把第一条 user 提示也瘦身（保留系统提示不在此列）
      if (messages[0] && String(messages[0].content || '').length > 20_000) {
        messages[0].content = String(messages[0].content).slice(0, 20_000) + '\n…[长提示已截断]'
      }
    }
  }

  try {
    for (iterations = 1; iterations <= maxIterations; iterations++) {
      if (signal?.aborted) throw new AiAbortError()
      const elapsed = Date.now() - startedAt
      if (Date.now() > deadline) throw new AiError('AI 运行超出时间上限，已停止')
      if (!softWarned && elapsed > deadlineMs * softDeadlineRatio) {
        softWarned = true
        emit({ type: 'warn', text: '时间预算已用 ' + Math.round((elapsed / deadlineMs) * 100) + '%，请尽快收尾' })
        messages.push({
          role: 'user',
          content: '时间预算已用掉 ' + Math.round((elapsed / deadlineMs) * 100) + '%。请立即收尾：不要再做新的探索，基于已有信息尽快调用收尾工具完成本次任务。',
        })
      }
      compact()
      emit({ type: 'iteration', iteration: iterations })
      const result = await client.streamChat({
        messages: [{ role: 'system', content: system }, ...messages],
        tools: toolDefs,
        signal,
        onDelta: (event) => {
          if (event.type === 'text') emit({ type: 'assistant-delta', text: event.text })
          else if (event.type === 'reasoning') emit({ type: 'reasoning-delta', text: event.text })
        },
      })
      const assistantContent = String(result.text || '')
      if (assistantContent) text += assistantContent
      const assistantMessage = { role: 'assistant', content: assistantContent, toolCalls: result.toolCalls || [] }
      messages.push(assistantMessage)

      if (!result.toolCalls || result.toolCalls.length === 0) {
        if (getFinished()) {
          emit({ type: 'finished', text: assistantContent })
          return { ok: true, aborted: false, finished: true, iterations, text, toolCalls: [] }
        }
        if (nudges < maxNudges) {
          nudges++
          emit({ type: 'warn', text: '模型没有调用工具，Host 让它继续（第 ' + nudges + ' 次提醒）' })
          messages.push({
            role: 'user',
            content: '你还没有完成流程。请继续按系统提示词操作：必须调用相应工具（创建快照的最后一步是 backup_build；恢复的最后一步是 restore_finish），不要只输出文字。',
          })
          continue
        }
        throw new AiError('AI 没有调用任何工具就结束了，无法确认快照/恢复完成')
      }

      for (const call of result.toolCalls) {
        const def = toolByName.get(call.name)
        emit({ type: 'tool-start', name: call.name, args: call.arguments })
        let content
        if (!def) {
          content = '错误：不存在名为 ' + call.name + ' 的工具。可用工具：' + [...toolByName.keys()].join(', ')
        } else {
          try {
            const out = await def.execute(call.arguments || {}, { signal, emit })
            content = typeof out === 'string' ? out : JSON.stringify(out)
            if (typeof def.summarize === 'function') {
              try {
                emit({ type: 'tool-result', name: call.name, summary: def.summarize(out) })
              } catch {}
            }
          } catch (error) {
            if (error && (error.name === 'AbortError' || error.kind === 'aborted')) throw new AiAbortError()
            content = '工具执行失败：' + String((error && error.message) || error)
            emit({ type: 'tool-result', name: call.name, summary: content, failed: true })
          }
        }
        content = truncate(content, maxToolResultChars)
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content })
        if (getFinished()) {
          emit({ type: 'finished', text: assistantContent })
          return { ok: true, aborted: false, finished: true, iterations, text, toolCalls: result.toolCalls }
        }
      }
    }
    throw new AiError('AI 工具调用轮数超出上限（' + maxIterations + '），已停止')
  } catch (error) {
    if (error && (error.kind === 'aborted' || error.name === 'AiAbortError')) {
      return { ok: false, aborted: true, finished: false, iterations, text, toolCalls: [], error: '用户中断' }
    }
    return {
      ok: false,
      aborted: false,
      finished: false,
      iterations,
      text,
      toolCalls: [],
      error: String((error && error.message) || error),
    }
  }
}
