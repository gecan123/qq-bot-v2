import type { AssistantToolCall } from './agent-context.types.js'
import { isSideEffectTool } from '../ops/tool-call-log.js'

/**
 * 只有明确列出的只读调用才允许并行；未知工具默认 exclusive。
 * deferred invoke 会递归检查真实内部工具与真实 args。
 */
export function isParallelSafeToolCall(call: AssistantToolCall): boolean {
  if (call.name === 'invoke') {
    const target = typeof call.args.tool === 'string' ? call.args.tool : null
    const targetArgs = call.args.args
    if (!target || !targetArgs || typeof targetArgs !== 'object' || Array.isArray(targetArgs)) return false
    return isParallelSafeToolCall({
      id: call.id,
      name: target,
      args: targetArgs as Record<string, unknown>,
    })
  }

  if (ALWAYS_READ_ONLY_TOOLS.has(call.name)) return true
  if (call.name === 'workspace_bash') return !isSideEffectTool(call.name, call.args)
  if (call.name === 'memory') return hasAction(call.args, ['search', 'recall', 'review', 'read', 'list'])
  if (call.name === 'journal') return hasAction(call.args, ['list', 'search', 'read'])
  if (call.name === 'life_journal') {
    return hasAction(call.args, ['read_recent', 'read_day', 'read_entry', 'read_agenda'])
  }
  if (call.name === 'background_task') return hasAction(call.args, ['list', 'get'])
  if (call.name === 'approval') return hasAction(call.args, ['list', 'status'])
  if (call.name === 'schedule') return hasAction(call.args, ['list'])
  if (call.name === 'goal') return hasAction(call.args, ['get'])
  if (call.name === 'todo') return hasAction(call.args, ['list'])
  if (call.name === 'collect_sticker') return hasAction(call.args, ['list', 'search', 'random'])
  if (call.name === 'workspace_file') return hasAction(call.args, ['list', 'read'])
  if (call.name === 'website') return hasAction(call.args, ['status', 'read'])
  if (call.name === 'trading_agent') return hasAction(call.args, ['status', 'result'])
  if (call.name === 'fetch_content') {
    return call.args.background !== true
      && hasAction(call.args, ['url', 'reddit_list', 'reddit_post'])
  }
  return false
}

const ALWAYS_READ_ONLY_TOOLS = new Set([
  'qq_directory',
  'inbox',
  'chat_style',
  'ai_tone',
  'skill',
  'web_search',
  'read_file',
  'openbb_cli',
])

function hasAction(args: Record<string, unknown>, actions: readonly string[]): boolean {
  return typeof args.action === 'string' && actions.includes(args.action)
}
