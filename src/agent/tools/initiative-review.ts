import { z } from 'zod'
import { loadPrompt } from '../../config/prompt-loader.js'
import type { LlmClient } from '../llm-client.js'
import { observeLlmCall } from '../llm-call-observability.js'
import type { Tool } from '../tool.js'

const INITIATIVE_REVIEW_PROMPT_PATH = './prompts/tools/initiative-review.md'
const MAX_MONOLOGUE_CHARS = 20_000
const MAX_OUTPUT_TOKENS = 8_192
const REVIEW_TIMEOUT_MS = 45_000

const argsSchema = z.object({
  text: z.string().min(1).max(MAX_MONOLOGUE_CHARS)
    .describe('需要检查的第一人称内心独白；保留完整场景和原本人称。'),
}).strict()

const resultSchema = z.object({
  hasNegative: z.boolean(),
  rewritten: z.string().max(MAX_MONOLOGUE_CHARS),
}).strict()

type InitiativeReviewArgs = z.infer<typeof argsSchema>
export type InitiativeReviewResult = z.infer<typeof resultSchema>

export function createInitiativeReviewTool(input: {
  llm: LlmClient
}): Tool<InitiativeReviewArgs> {
  return {
    name: 'initiative_review',
    description: [
      '检查第一人称内心独白是否在无必要地等待、拖延、躺平、装困摆烂或绕开系统要求，并把这些部分改写成自然的主动行动。',
      '当你已经准备推进，或只是在客观描述状态时不要调用。',
      '当你准备因为“以后再说”“不打扰”“算了”“先歇着”等理由停下一个仍可立即推进的方向时，先把完整想法交给本工具；hasNegative=true 时按 rewritten 继续。',
    ].join(' '),
    schema: argsSchema,
    async execute(args, ctx) {
      try {
        const output = await observeLlmCall({
          llm: input.llm,
          request: {
            systemPrompt: loadPrompt(INITIATIVE_REVIEW_PROMPT_PATH),
            messages: [{ role: 'user', content: args.text }],
            tools: [],
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
          },
          context: {
            operation: 'agent.initiative_review',
            actor: 'initiative_review_tool',
            roundIndex: ctx.roundIndex,
          },
        })
        const parsed = resultSchema.parse(JSON.parse(output.content.trim()))
        const result: InitiativeReviewResult = parsed.hasNegative
          ? parsed
          : { hasNegative: false, rewritten: args.text }
        return {
          content: JSON.stringify({ ok: true, ...result }),
          outcome: { ok: true },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: JSON.stringify({
            ok: false,
            code: 'initiative_review_failed',
            error: message,
          }),
          outcome: {
            ok: false,
            code: 'initiative_review_failed',
            error: message,
            progress: false,
          },
        }
      }
    },
  }
}
