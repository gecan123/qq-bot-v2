/**
 * Anthropic /v1/messages?beta=true SSE response 解析。
 *
 * Kagami 风格: 一次性 await response.text() 拿到完整 SSE body, 再 split & 重组成
 * 与非流式 API 同形的 ClaudeMessageResponse。这样上层 LlmClient 不需要处理流式细节。
 *
 * 移植自 kagami claude-code-provider.ts:711-903。事件类型:
 *   message_start / content_block_start / content_block_delta / content_block_stop / message_delta
 */

export interface ClaudeMessageResponse {
  id?: string
  type?: string
  role?: string
  model?: string
  content?: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
  >
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  error?: {
    type?: string
    message?: string
  }
}

type StreamBlock =
  | { kind: 'ignored' }
  | { kind: 'text'; block: { type: 'text'; text: string } }
  | {
      kind: 'tool_use'
      block: { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
      partialJson: string
    }

export function parseClaudeStreamResponse(value: string): ClaudeMessageResponse | null {
  if (!value.startsWith('event:')) return null

  const streamBlocks: StreamBlock[] = []
  let model: string | undefined
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let cacheReadInputTokens: number | undefined
  let cacheCreationInputTokens: number | undefined

  for (const chunk of value.split('\n\n')) {
    const lines = chunk
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
    if (lines.length === 0) continue

    const dataLine = lines.find((line) => line.startsWith('data:'))
    if (!dataLine) continue

    const dataJson = dataLine.slice('data:'.length).trim()
    if (!dataJson.startsWith('{')) continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(dataJson) as Record<string, unknown>
    } catch {
      continue
    }

    if (parsed.type === 'message_start') {
      const message = isRecord(parsed.message) ? parsed.message : null
      if (message && typeof message.model === 'string') {
        model = message.model
      }
      const usage = message && isRecord(message.usage) ? message.usage : null
      if (usage) {
        if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens
        if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens
        if (typeof usage.cache_read_input_tokens === 'number') {
          cacheReadInputTokens = usage.cache_read_input_tokens
        }
        if (typeof usage.cache_creation_input_tokens === 'number') {
          cacheCreationInputTokens = usage.cache_creation_input_tokens
        }
      }
      continue
    }

    if (parsed.type === 'content_block_start') {
      const index = typeof parsed.index === 'number' ? parsed.index : -1
      const contentBlock = isRecord(parsed.content_block) ? parsed.content_block : null
      if (index < 0 || !contentBlock) continue

      if (contentBlock.type === 'text') {
        streamBlocks[index] = {
          kind: 'text',
          block: {
            type: 'text',
            text: typeof contentBlock.text === 'string' ? contentBlock.text : '',
          },
        }
        continue
      }

      if (contentBlock.type === 'tool_use') {
        streamBlocks[index] = {
          kind: 'tool_use',
          block: {
            type: 'tool_use',
            ...(typeof contentBlock.id === 'string' ? { id: contentBlock.id } : {}),
            ...(typeof contentBlock.name === 'string' ? { name: contentBlock.name } : {}),
            ...(isRecord(contentBlock.input) ? { input: contentBlock.input } : {}),
          },
          partialJson: '',
        }
        continue
      }

      streamBlocks[index] = { kind: 'ignored' }
      continue
    }

    if (parsed.type === 'content_block_delta') {
      const index = typeof parsed.index === 'number' ? parsed.index : -1
      const streamBlock = index >= 0 ? streamBlocks[index] : undefined
      const delta = isRecord(parsed.delta) ? parsed.delta : null
      if (!streamBlock || !delta) continue

      if (streamBlock.kind === 'text' && delta.type === 'text_delta') {
        streamBlock.block.text += typeof delta.text === 'string' ? delta.text : ''
        continue
      }

      if (streamBlock.kind === 'tool_use' && delta.type === 'input_json_delta') {
        streamBlock.partialJson +=
          typeof delta.partial_json === 'string' ? delta.partial_json : ''
      }
      continue
    }

    if (parsed.type === 'content_block_stop') {
      const index = typeof parsed.index === 'number' ? parsed.index : -1
      const streamBlock = index >= 0 ? streamBlocks[index] : undefined
      if (!streamBlock || streamBlock.kind !== 'tool_use' || streamBlock.partialJson.length === 0) {
        continue
      }

      try {
        const parsedInput = JSON.parse(streamBlock.partialJson) as unknown
        if (isRecord(parsedInput)) {
          streamBlock.block.input = parsedInput
        }
      } catch {
        streamBlock.block.input = {}
      }
      continue
    }

    if (parsed.type === 'message_delta') {
      const usage = isRecord(parsed.usage) ? parsed.usage : null
      if (usage) {
        if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens
        if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens
        if (typeof usage.cache_read_input_tokens === 'number') {
          cacheReadInputTokens = usage.cache_read_input_tokens
        }
        if (typeof usage.cache_creation_input_tokens === 'number') {
          cacheCreationInputTokens = usage.cache_creation_input_tokens
        }
      }
    }
  }

  const content = streamBlocks.flatMap((block) => {
    if (!block || block.kind === 'ignored') return []
    return [block.block]
  })

  // 注意: content.length === 0 是合法的 (模型可以选择 end_turn 不输出 content_block).
  // 这种情况返回 content:[] 让上层判定, 不要在这里塞 null 跟"SSE 真损坏"混到同一个返回值。

  return {
    type: 'message',
    role: 'assistant',
    ...(model ? { model } : {}),
    content,
    ...(inputTokens !== undefined ||
    outputTokens !== undefined ||
    cacheReadInputTokens !== undefined ||
    cacheCreationInputTokens !== undefined
      ? {
          usage: {
            ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
            ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
            ...(cacheReadInputTokens !== undefined
              ? { cache_read_input_tokens: cacheReadInputTokens }
              : {}),
            ...(cacheCreationInputTokens !== undefined
              ? { cache_creation_input_tokens: cacheCreationInputTokens }
              : {}),
          },
        }
      : {}),
  }
}

/** 兼容: 上游可能直接返回非流式 JSON (e.g. error 时), 这种就直接 JSON.parse。 */
export function parseClaudeMessageResponse(value: string): ClaudeMessageResponse | null {
  const stream = parseClaudeStreamResponse(value)
  if (stream) return stream
  try {
    return JSON.parse(value) as ClaudeMessageResponse
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
