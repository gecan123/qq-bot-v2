import { createLogger } from '../../logger.js'
import { appendLogLine } from '../../ops/append-log-line.js'
import { formatBeijingIso } from '../../utils/beijing-time.js'
import type { ClaudeAssistantNativeBlock } from '../agent-context.types.js'

const log = createLogger('CLAUDE_THINKING_LOG')

const DEFAULT_CLAUDE_THINKING_LOG_PATH = 'logs/claude-thinking.ndjson'

export type ClaudeThinkingLogMode = 'off' | 'summary' | 'raw'

export interface ClaudeThinkingLogOptions {
  mode?: ClaudeThinkingLogMode
  path?: string
  appender?: (path: string, line: string) => Promise<void>
}

export interface ClaudeThinkingLogBlock {
  blockIndex: number
  block: ClaudeAssistantNativeBlock
}

export interface LogClaudeThinkingBlocksInput {
  model: string
  blocks: ClaudeThinkingLogBlock[]
  toolCallIds: string[]
  options?: ClaudeThinkingLogOptions
}

export async function logClaudeThinkingBlocks(
  input: LogClaudeThinkingBlocksInput,
): Promise<void> {
  const mode = input.options?.mode ?? 'off'
  if (mode === 'off' || input.blocks.length === 0) return

  const path = input.options?.path ?? DEFAULT_CLAUDE_THINKING_LOG_PATH
  const appender = input.options?.appender ?? appendLogLine

  for (const { blockIndex, block } of input.blocks) {
    const entry =
      mode === 'raw'
        ? rawEntry(input.model, blockIndex, block, input.toolCallIds)
        : summaryEntry(input.model, blockIndex, block, input.toolCallIds)
    try {
      await appender(path, JSON.stringify(entry) + '\n')
    } catch (err) {
      log.warn(
        { err, path, model: input.model, blockIndex, type: block.type },
        'claude_thinking_log_write_failed',
      )
    }
  }
}

function rawEntry(
  model: string,
  blockIndex: number,
  block: ClaudeAssistantNativeBlock,
  toolCallIds: string[],
): Record<string, unknown> {
  return {
    ts: formatBeijingIso(new Date()),
    model,
    blockIndex,
    type: block.type,
    ...(typeof block.text === 'string' ? { text: block.text } : {}),
    ...(typeof block.thinking === 'string' ? { thinking: block.thinking } : {}),
    ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
    ...(typeof block.data === 'string' ? { data: block.data } : {}),
    toolCallIds,
  }
}

function summaryEntry(
  model: string,
  blockIndex: number,
  block: ClaudeAssistantNativeBlock,
  toolCallIds: string[],
): Record<string, unknown> {
  return {
    ts: formatBeijingIso(new Date()),
    model,
    blockIndex,
    type: block.type,
    ...(typeof block.text === 'string' ? { textLength: block.text.length } : {}),
    ...(typeof block.thinking === 'string' ? { thinkingLength: block.thinking.length } : {}),
    ...(typeof block.data === 'string' ? { dataLength: block.data.length } : {}),
    hasSignature: typeof block.signature === 'string' && block.signature.length > 0,
    toolCallIds,
  }
}
