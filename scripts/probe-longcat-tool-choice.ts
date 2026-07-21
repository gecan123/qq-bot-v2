/**
 * 探测 LongCat Anthropic endpoint 对 tool_choice 的真实兼容性。
 *
 * 这个脚本只声明一个不会被执行的 ping 工具，并检查模型返回的 content block；
 * 它不会执行 tool_use，也不会打印 API key、thinking 正文或普通回复正文。
 * 每次运行会发 8 个小请求，产生少量 API token 消耗。
 *
 * 用法：
 *   pnpm probe:longcat-tool-choice
 */
import 'dotenv/config'
import { buildClaudeCodeHeaders } from '../src/agent/claude-code/headers.js'
import {
  parseClaudeMessageResponse,
  type ClaudeMessageResponse,
} from '../src/agent/claude-code/sse-parser.js'

type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: 'ping' }
  | { type: 'none' }

type Thinking =
  | { label: 'omitted'; body?: undefined }
  | { label: 'adaptive'; body: { type: 'adaptive'; display: 'summarized' } }

interface ProbeCase {
  label: string
  thinking: Thinking
  toolChoice: ToolChoice
}

interface ProbeResult {
  case: string
  http: number | 'ERR'
  parsed: 'yes' | 'no'
  stopReason: string
  blocks: string
  tools: string
  semantics: 'obeyed' | 'violated' | 'inconclusive'
  detail: string
}

const baseURL = process.env.LLM_PROVIDER_CLAUDE_URL
const apiKey = process.env.LLM_PROVIDER_CLAUDE_API_KEY
const model = process.env.LLM_DEFAULT_MODEL ?? 'LongCat-2.0'
const timeoutMs = 30_000

if (!baseURL || !apiKey) {
  console.error('需要在 .env 配置 LLM_PROVIDER_CLAUDE_URL 和 LLM_PROVIDER_CLAUDE_API_KEY')
  process.exit(1)
}

const thinkingVariants: Thinking[] = [
  { label: 'omitted' },
  { label: 'adaptive', body: { type: 'adaptive', display: 'summarized' } },
]

const toolChoices: ToolChoice[] = [
  { type: 'auto' },
  { type: 'any' },
  { type: 'tool', name: 'ping' },
  { type: 'none' },
]

const cases: ProbeCase[] = thinkingVariants.flatMap((thinking) =>
  toolChoices.map((toolChoice) => ({
    label: `${thinking.label}:${toolChoice.type}`,
    thinking,
    toolChoice,
  })),
)

function contentBlocks(response: ClaudeMessageResponse): Array<Record<string, unknown>> {
  return Array.isArray(response.content)
    ? response.content.filter(
      (block): block is Record<string, unknown> => Boolean(block) && typeof block === 'object',
    )
    : []
}

function evaluateSemantics(
  toolChoice: ToolChoice,
  blocks: Array<Record<string, unknown>>,
): ProbeResult['semantics'] {
  const toolUseBlocks = blocks.filter((block) => block.type === 'tool_use')

  if (toolChoice.type === 'none') return toolUseBlocks.length === 0 ? 'obeyed' : 'violated'
  if (toolChoice.type === 'any') return toolUseBlocks.length > 0 ? 'obeyed' : 'violated'
  if (toolChoice.type === 'tool') {
    return toolUseBlocks.some((block) => block.name === toolChoice.name) ? 'obeyed' : 'violated'
  }

  // auto 允许调用或不调用；只要响应可解析，就不能仅凭是否调用工具判断失败。
  return 'obeyed'
}

async function probe(input: ProbeCase): Promise<ProbeResult> {
  const body = {
    model,
    stream: true,
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: 'Call the ping tool if the request permits it. Otherwise reply with PONG.',
      },
    ],
    tools: [
      {
        name: 'ping',
        description: 'A harmless compatibility probe. The client will not execute it.',
        input_schema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ],
    tool_choice: input.toolChoice,
    ...(input.thinking.body ? { thinking: input.thinking.body } : {}),
  }

  try {
    const response = await fetch(`${baseURL}/messages?beta=true`, {
      method: 'POST',
      headers: buildClaudeCodeHeaders({ accessToken: apiKey!, timeoutMs }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const responseText = await response.text()
    const parsed = parseClaudeMessageResponse(responseText)

    if (!parsed) {
      return {
        case: input.label,
        http: response.status,
        parsed: 'no',
        stopReason: '-',
        blocks: '-',
        tools: '-',
        semantics: 'inconclusive',
        detail: responseText.length === 0
          ? '响应体为空（空 SSE）'
          : responseText.slice(0, 160).replaceAll(/\s+/g, ' '),
      }
    }

    const blocks = contentBlocks(parsed)
    const blockTypes = blocks
      .map((block) => typeof block.type === 'string' ? block.type : '?')
      .join(',') || '(empty)'
    const toolNames = blocks
      .filter((block) => block.type === 'tool_use')
      .map((block) => typeof block.name === 'string' ? block.name : '?')
      .join(',') || '-'

    return {
      case: input.label,
      http: response.status,
      parsed: 'yes',
      stopReason: parsed.stop_reason ?? '-',
      blocks: blockTypes,
      tools: toolNames,
      semantics: evaluateSemantics(input.toolChoice, blocks),
      detail: blocks.length === 0 ? 'HTTP 成功但 content 为空' : '',
    }
  } catch (error) {
    return {
      case: input.label,
      http: 'ERR',
      parsed: 'no',
      stopReason: '-',
      blocks: '-',
      tools: '-',
      semantics: 'inconclusive',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function main(): Promise<void> {
  console.log(`LongCat tool_choice probe: model=${model}, endpoint=${baseURL}/messages?beta=true`)
  console.log('注意：HTTP 200 只代表参数被接收；semantics 才表示返回是否遵守 tool_choice。\n')

  const results: ProbeResult[] = []
  for (const input of cases) {
    results.push(await probe(input))
  }

  console.table(results)

  const unusable = results.filter((result) => result.http !== 200 || result.parsed === 'no')
  const conclusive = results.filter((result) => result.semantics !== 'inconclusive')
  const violations = conclusive.filter((result) => result.semantics === 'violated')
  console.log(
    `\n结论：${results.length - unusable.length}/${results.length} 个请求得到可用响应，`
    + `${conclusive.length}/${results.length} 个可判定 tool_choice 语义。`,
  )
  if (unusable.length > 0) {
    console.log(`不可用项：${unusable.map((result) => result.case).join(', ')}`)
  }
  if (violations.length > 0) {
    console.log(`违反项：${violations.map((result) => result.case).join(', ')}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
