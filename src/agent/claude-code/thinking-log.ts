import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createLogger } from '../../logger.js'
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

let parentDirEnsured = new Set<string>()

async function defaultAppender(path: string, line: string): Promise<void> {
  const dir = dirname(path)
  if (!parentDirEnsured.has(dir)) {
    await mkdir(dir, { recursive: true })
    parentDirEnsured.add(dir)
  }
  await appendFile(path, line, 'utf8')
}

export async function logClaudeThinkingBlocks(
  input: LogClaudeThinkingBlocksInput,
): Promise<void> {
  const mode = input.options?.mode ?? 'off'
  if (mode === 'off' || input.blocks.length === 0) return

  const path = input.options?.path ?? DEFAULT_CLAUDE_THINKING_LOG_PATH
  const appender = input.options?.appender ?? defaultAppender

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

/** 测试用 reset; 生产代码不应调用。 */
export function __resetClaudeThinkingLogStateForTest(): void {
  parentDirEnsured = new Set<string>()
}
