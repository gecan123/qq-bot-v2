import type { AssistantToolCall } from './agent-context.types.js'
import type { ToolExecutor } from './tool.js'

/**
 * 并发判定只消费 ToolExecutor 暴露的统一 policy；deferred invoke 由执行器
 * 解析到真实内部工具后再分类，避免这里维护第二份 name/action 白名单。
 */
export function isParallelSafeToolCall(
  tools: ToolExecutor,
  call: AssistantToolCall,
): boolean {
  return tools.classify(call).concurrency === 'parallel'
}
