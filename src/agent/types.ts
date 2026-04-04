import type { ZodType } from 'zod'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  name: string
  output: string
  error?: string
}

export interface AgentToolDeclaration {
  name: string
  description: string
  inputSchema: ZodType
}

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'model'; content: string }
  | { role: 'tool_calls'; calls: ToolCall[] }
  | { role: 'tool_results'; results: ToolResult[] }

export type AgentTurnResult =
  | { type: 'tool_calls'; calls: ToolCall[]; model?: string }
  | { type: 'text'; content: string; model?: string }
  | { type: 'empty' }

export type AgentLoopResult =
  | { state: 'final'; answer: string; termination: 'final_answer' | 'implicit_text' }
  | { state: 'fallback'; reason: string }
  | { state: 'aborted'; reason: string }
