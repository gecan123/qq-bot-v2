import type { AgentMessage, ToolCall, ToolResult } from './types.js'

/**
 * 控制工具白名单。这些 call 不能作为普通 tool_calls 落进 AgentContext,
 * 而是提取参数转成 model role 文本(等价于 Kagami 的 omitControlToolCalls)。
 *
 * 当前只有 final_answer。新加的「控制」语义工具(只用来约束输出形态、本身
 * 不携带跨轮可见的事实信息)在加入 set 之前要先想清楚:这个 call 在历史里
 * 长期保留对下一轮模型有用吗?有用 → 普通 tool;无用且嘈杂 → 控制 tool。
 */
export const CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set(['final_answer'])

export interface AgentContextSnapshot {
  messages: AgentMessage[]
  /**
   * 已经摄入到 messages 数组里的群消息中最大的 messageRowId。
   * 增量摄入用 (Phase C):每次 @ 触发时 ingestor 拉取 cursor 之后的群消息和
   * sent action_records, append 进 messages, 然后推进 cursor。
   *
   * 这是元数据, 不影响 LLM 看到的 messages 字节, 也不进入 prefix hash 计算。
   */
  lastObservedMessageRowId?: number
}

export interface AgentContext {
  /** LLM 可见历史的真身。snapshot 是只读副本,外部修改不影响内部状态。 */
  getSnapshot(): Promise<AgentContextSnapshot>
  /** 入站用户事实。append 时刻冻结;之后即使源数据回填也不重写本对象。 */
  appendUserMessage(message: Extract<AgentMessage, { role: 'user' }>): Promise<void>
  /** bot 的最终文本输出。final_answer 也走这里。 */
  appendAssistantTurn(message: Extract<AgentMessage, { role: 'model' }>): Promise<void>
  /**
   * 普通 tool 调用入账。
   * 内部会过滤掉 CONTROL_TOOL_NAMES 命中的 call:
   * - 控制 call(如 final_answer):提取参数转成 model role appendAssistantTurn
   * - 非控制 call:作为 tool_calls turn 落账
   * 全 batch 都是控制 call 时不写 tool_calls turn。
   */
  appendToolCalls(calls: ToolCall[]): Promise<void>
  /** tool 执行结果入账。空数组时不写入。 */
  appendToolResults(results: ToolResult[]): Promise<void>
  /**
   * compaction 用。原子替换全部 messages,典型用法:
   * replaceMessages([summaryHead, ...keptTail])
   * 调用方负责保证 keptTail 字节不变,从而保留 prefix 稳定性。
   */
  replaceMessages(messages: AgentMessage[]): Promise<void>
  /** 持久化用。返回深拷贝。 */
  exportSnapshot(): Promise<AgentContextSnapshot>
  /** 持久化恢复用。原子覆盖。 */
  restoreFromSnapshot(snapshot: AgentContextSnapshot): Promise<void>
  /** 清空。仅用于测试。 */
  reset(): Promise<void>
  /** 推进增量摄入游标。新值必须大于等于当前值,否则忽略。 */
  setLastObservedMessageRowId(rowId: number): Promise<void>
  /** 读当前游标。无记录时返回 0。 */
  getLastObservedMessageRowId(): number
}

interface CreateAgentContextOptions {
  /** 初始 messages。restoreFromSnapshot 的便捷构造形式。 */
  initialMessages?: AgentMessage[]
  initialLastObservedMessageRowId?: number
}

export function createAgentContext(options: CreateAgentContextOptions = {}): AgentContext {
  let messages: AgentMessage[] = options.initialMessages ? cloneMessages(options.initialMessages) : []
  let lastObservedMessageRowId: number = options.initialLastObservedMessageRowId ?? 0

  return {
    async getSnapshot() {
      return { messages: cloneMessages(messages), lastObservedMessageRowId }
    },
    async appendUserMessage(message) {
      messages.push(cloneMessage(message))
    },
    async appendAssistantTurn(message) {
      messages.push(cloneMessage(message))
    },
    async appendToolCalls(calls) {
      if (calls.length === 0) return
      const nonControl: ToolCall[] = []
      for (const call of calls) {
        if (CONTROL_TOOL_NAMES.has(call.name)) {
          const text = extractControlToolText(call)
          if (text) {
            messages.push({ role: 'model', content: text })
          }
          continue
        }
        nonControl.push(cloneToolCall(call))
      }
      if (nonControl.length > 0) {
        messages.push({ role: 'tool_calls', calls: nonControl })
      }
    },
    async appendToolResults(results) {
      if (results.length === 0) return
      messages.push({ role: 'tool_results', results: results.map(cloneToolResult) })
    },
    async replaceMessages(next) {
      messages = cloneMessages(next)
    },
    async exportSnapshot() {
      return { messages: cloneMessages(messages), lastObservedMessageRowId }
    },
    async restoreFromSnapshot(snapshot) {
      messages = cloneMessages(snapshot.messages)
      lastObservedMessageRowId = snapshot.lastObservedMessageRowId ?? 0
    },
    async reset() {
      messages = []
      lastObservedMessageRowId = 0
    },
    async setLastObservedMessageRowId(rowId) {
      if (rowId > lastObservedMessageRowId) lastObservedMessageRowId = rowId
    },
    getLastObservedMessageRowId() {
      return lastObservedMessageRowId
    },
  }
}

/**
 * 从 final_answer / 其它控制工具的 args 中提取要落进 model role 的文本。
 * 当前 final_answer 兼容两种字段名(replyText / text),保持和 src/agent/loop.ts 一致。
 * 找不到任何文本字段时返回空串,调用方据此跳过写入。
 */
function extractControlToolText(call: ToolCall): string {
  if (call.name === 'final_answer') {
    const replyText = call.args['replyText']
    if (typeof replyText === 'string') return replyText
    const text = call.args['text']
    if (typeof text === 'string') return text
  }
  return ''
}

function cloneMessages(input: AgentMessage[]): AgentMessage[] {
  return input.map(cloneMessage)
}

function cloneMessage(input: AgentMessage): AgentMessage {
  switch (input.role) {
    case 'user':
    case 'model':
      return { role: input.role, content: input.content }
    case 'tool_calls':
      return { role: 'tool_calls', calls: input.calls.map(cloneToolCall) }
    case 'tool_results':
      return { role: 'tool_results', results: input.results.map(cloneToolResult) }
  }
}

function cloneToolCall(call: ToolCall): ToolCall {
  return { id: call.id, name: call.name, args: { ...call.args } }
}

function cloneToolResult(result: ToolResult): ToolResult {
  const next: ToolResult = {
    callId: result.callId,
    name: result.name,
    output: result.output,
  }
  if (result.error !== undefined) next.error = result.error
  return next
}
