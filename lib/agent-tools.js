// dsh-backup-all · 暴露给 DSH 主 Agent 的工具
//
// 用户要求：把「创建快照 / 恢复快照」也暴露成主 Agent 可调用的工具，
// 但必须在工具描述里明确标注：**非用户明确要求时绝对不可以私自调用，也不可以主动建议使用**。
//
// 设计与插件内 AI 工具区分：
//   - 这两个工具只负责「启动后台运行」，立刻返回 runId；进度在 Backup ALL 设置页 / 悬浮球里看；
//   - 恢复工具强制要求 confirm: true，并且会先自动创建「恢复前快照」；
//   - 恢复结束后依赖安装由 Host 强制收尾（用户明确要求）。

const WARNING =
  '【使用限制·必须遵守】本工具仅在用户**明确、直接要求**执行对应操作时才可以调用；' +
  '不得在用户没有明确要求时私自调用，也不得主动向用户建议/推销使用本工具。' +
  '如果用户只是询问、讨论或让你「看看备份插件」，不要调用。'

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

/**
 * @param {object} runtime createBackupRuntime() 的返回值
 * @returns {Array<object>} tool definitions（Cordis tool registry 格式）
 */
export function createAgentToolDefinitions(runtime) {
  const createSnapshotTool = {
    name: 'backup_all_create_snapshot',
    description:
      WARNING +
      '\n作用：为当前 DSH 环境创建一个 Backup ALL 快照（由用户在 Backup ALL 高级设置里配置的独立 AI 模型驱动：扫描插件/Skill/MCP/Agent Preset、' +
      '打包配置与外部文件、写恢复说明、高压缩归档到插件目录 backup/，并登记到快照列表）。' +
      '\n执行方式：只在后台启动，立即返回 runId，**不等待完成**；进度请告诉用户到 设置 → Backup ALL（或贴边悬浮球）查看。' +
      '\n限制：调用前必须先确认用户原话中明确要求「创建快照/备份当前环境」；启动后不要轮询进度，也不要反复调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          description: '快照名称；不传则由 Host 用当前时间生成（YYYY-MM-DD HH-mm-ss）',
        },
        description: {
          type: 'string',
          description: '快照描述（为什么创建），可空',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          message: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        const v = value || {}
        const text = v.ok
          ? 'Backup ALL 快照已开始（runId: ' + (v.runId || '') + '）。进度在 设置 → Backup ALL 或悬浮球查看。' + (v.message ? '\n' + v.message : '')
          : '启动快照失败：' + (v.error || '未知错误')
        return [{ type: 'text', text }]
      },
    },
    async execute(args) {
      const result = runtime.startSnapshot({
        name: args && args.name,
        description: args && args.description,
      })
      if (!result || !result.ok) {
        return { ok: false, error: (result && result.error) || '启动失败' }
      }
      return {
        ok: true,
        runId: result.runId,
        message: '已后台启动。不要轮询；用户可在设置页/悬浮球看进度，完成后快照出现在快照列表。',
      }
    },
  }

  const restoreSnapshotTool = {
    name: 'backup_all_restore_snapshot',
    description:
      WARNING +
      '\n作用：把当前 DSH 环境恢复到某个 Backup ALL 快照（恢复前会自动创建并保留一份「恢复前快照」，用于中断/失败回滚）。' +
      '\n执行方式：只在后台启动，立即返回 runId，**不等待完成**；恢复 AI 会解包、自动重映射路径、写回配置/插件代码/外部文件，' +
      '最后 AI 与 Host 各执行一次依赖安装；完成后需要重启 DSH。' +
      '\n限制：这是破坏性操作。调用前必须确认用户原话中明确要求「恢复到某个快照/回滚到之前的环境」，并把快照名/ID 与用户确认；' +
      '不确定时先问用户，不要猜。必须传 confirm: true（表示已获得用户明确要求）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '快照记录 id（优先使用；从用户提供的快照列表里拿）' },
        name: { type: 'string', description: '快照名称（用户只给了名字时用；必须能精确或唯一匹配）' },
        confirm: {
          type: 'boolean',
          description: '只有用户明确要求恢复时才传 true；表示你已核对过目标快照',
        },
      },
      required: ['confirm'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          chosen: { type: 'string' },
          message: { type: 'string' },
          error: { type: 'string' },
          candidates: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const v = value || {}
        if (v.ok) {
          return [{
            type: 'text',
            text: 'Backup ALL 恢复已开始（runId: ' + (v.runId || '') + '，目标：' + (v.chosen || '') + '）。' +
              '恢复前快照已自动创建；进度在设置页/悬浮球查看，完成后需重启 DSH。',
          }]
        }
        const lines = ['启动恢复失败：' + (v.error || '未知错误')]
        if (Array.isArray(v.candidates) && v.candidates.length) lines.push('候选快照：\n- ' + v.candidates.join('\n- '))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const input = args || {}
      if (input.confirm !== true) {
        return { ok: false, error: '必须传入 confirm: true，且仅当用户明确要求恢复时；请先向用户确认目标快照。' }
      }
      const records = runtime.store.listRecords ? runtime.store.listRecords() : []
      let record = null
      if (input.id) {
        record = records.find((item) => item.id === String(input.id)) || null
        if (!record) return { ok: false, error: '找不到该快照 id：' + String(input.id) }
      } else if (input.name) {
        const wanted = normalizeName(input.name)
        const exact = records.filter((item) => normalizeName(item.name) === wanted)
        const partial = exact.length ? exact : records.filter((item) => normalizeName(item.name).includes(wanted))
        if (partial.length === 0) {
          return {
            ok: false,
            error: '找不到名称匹配的快照：' + input.name,
            candidates: records.map((item) => item.name + '（' + item.id + '）').slice(0, 10),
          }
        }
        if (partial.length > 1) {
          return {
            ok: false,
            error: '名称匹配到多个快照，请让用户选择后传 id：',
            candidates: partial.map((item) => item.name + '（' + item.id + '）'),
          }
        }
        record = partial[0]
      } else {
        return {
          ok: false,
          error: '必须提供 id 或 name（快照列表可通过 Backup ALL 设置页查看）',
          candidates: records.map((item) => item.name + '（' + item.id + '）').slice(0, 10),
        }
      }
      const result = runtime.startRestore({ id: record.id })
      if (!result || !result.ok) return { ok: false, error: (result && result.error) || '启动恢复失败' }
      return {
        ok: true,
        runId: result.runId,
        chosen: record.name + '（' + record.id + '）',
        message: '已后台启动恢复：先自动创建恢复前快照，再由恢复 AI 执行；完成后需重启 DSH。不要轮询。',
      }
    },
  }

  return [createSnapshotTool, restoreSnapshotTool]
}
