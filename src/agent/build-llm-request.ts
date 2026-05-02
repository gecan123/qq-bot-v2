import type { AgentMessage } from './types.js'
import type { AgentContextSnapshot } from './agent-context.js'

/**
 * 构造发给 LLM 的完整 messages 列表。
 *
 * 语义保证:
 * - `snapshot.messages` 是持久化的 prefix——`scene_agent_contexts.snapshot` 里
 *   实际存的内容,跨 LLM 调用稳定。
 * - `ephemeralSuffix` 是 per-call 临时附加,**永远不写回** AgentContext。
 *   loop 步内构造,调完即丢,下一步可以传不一样的内容。
 *
 * 这是 Phase 1 「volatile tail digest 注入」的物理实现:WorldModelExtension 的
 * `onBeforeRound` / inner_journal 注入路径都通过 ephemeralSuffix 把 transient 信息
 * 喂给 LLM,而不是 mutate AgentContext.snapshot——保 prefix 字节级稳定 (CLAUDE.md
 * 不变量 #1 + #5)。
 *
 * MVP 阶段 (OpenAI-compatible adapter):简单拼接。provider 自动 prefix caching
 * 会自然命中 snapshot.messages 那段;suffix 只让"未缓存尾巴"长一些。
 *
 * 未来若接 Anthropic 原生 cache_control:在 snapshot 末尾 + suffix 头部之间插入
 * cache breakpoint。返回类型保留对象包裹,留扩展空间。
 */
export interface LlmRequestPayload {
  messages: AgentMessage[]
}

export function buildLlmRequest(
  snapshot: AgentContextSnapshot,
  ephemeralSuffix: AgentMessage[] = [],
): LlmRequestPayload {
  return {
    messages: [...snapshot.messages, ...ephemeralSuffix],
  }
}
