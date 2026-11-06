// dsh-backup-all · 宿主半边入口
//
// 这个文件只做接线：
//   1) 构造运行期（读环境、记录文件、AI 配置、管理后台任务）
//   2) 注册 /dsh-backup-all/* HTTP 路由（浏览器端 UI 用）
//   3) 插件卸载时中止正在跑的任务并清理缓存
//
// 纪律：apply() 绝不抛错。抛错会让该 Loader 条目的 fiber 失败，拖累整棵插件树。
// 只声明确定存在的服务 webServer；其它服务（pluginManager / workspaceRegistry / connection）
// 一律用 ctx.get 现取现判，缺失就走兜底逻辑。

import { createBackupRuntime } from './lib/runner.js'
import { registerRoutes } from './lib/routes.js'
import { createAgentToolDefinitions } from './lib/agent-tools.js'

export const name = 'dsh-backup-all'
export const inject = ['webServer']

export function apply(ctx, config) {
  try {
    const runtime = createBackupRuntime(ctx, config || {})
    registerRoutes(ctx, runtime)

    // 把「创建快照 / 恢复快照」暴露成 DSH 主 Agent 工具。
    // 工具描述里已明确标注使用限制（非用户明确要求不可调用/不可主动建议）。
    // 这里用 ctx.inject 等待 tools 服务就绪；注册失败不影响插件其余功能。
    try {
      ctx.inject(['tools'], (toolsCtx) => {
        try {
          const definitions = createAgentToolDefinitions(runtime)
          for (const definition of definitions) {
            toolsCtx.effect(() => toolsCtx.tools.register(definition), 'dsh-backup-all: agent tool ' + definition.name)
          }
        } catch (error) {
          try {
            const logger = typeof toolsCtx.logger === 'function' ? toolsCtx.logger('dsh-backup-all') : toolsCtx.logger
            const message = '[dsh-backup-all] 主 Agent 工具注册失败：' + String((error && error.message) || error)
            if (logger && typeof logger.error === 'function') logger.error(message)
            else console.error(message)
          } catch {}
        }
      })
    } catch (error) {
      try {
        console.error('[dsh-backup-all] 无法注入 tools 服务（主 Agent 工具不可用）：' + String((error && error.message) || error))
      } catch {}
    }
    ctx.effect(
      () => () => {
        try {
          runtime.dispose()
        } catch {}
      },
      'dsh-backup-all: dispose runtime',
    )
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-backup-all') : ctx.logger
      if (logger && typeof logger.info === 'function') {
        logger.info('[dsh-backup-all] host ready (version %s, backup dir %s)', runtime.version, runtime.env.backupDir)
      }
    } catch {}
  } catch (error) {
    // 启动失败只告警：绝不阻断 DSH 启动
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-backup-all') : ctx.logger
      const message = '[dsh-backup-all] 启动失败：' + String((error && error.stack) || error)
      if (logger && typeof logger.error === 'function') logger.error(message)
      else console.error(message)
    } catch {}
  }
}

export default { name, inject, apply }
