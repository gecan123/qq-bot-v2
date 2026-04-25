import OpenAI from 'openai'
import { jsonrepair } from 'jsonrepair'
import { z } from 'zod'
import { loadPrompt } from '../config/prompt-loader.js'
import { config } from '../config/index.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import type { ParsedSegment } from '../types/message-segments.js'

const PROACTIVE_JUDGE_REASON_LIMIT = 280

export interface ProactiveJudgeRawResult {
  shouldSpeak: boolean
  usefulness: number
  novelty: number
  confidence: number
  interruptionCost: number
  socialRisk: number
  suggestedDelayMs?: number
  reason: string
}

export type ProactiveJudgeAdviceStatus = 'valid' | 'invalid' | 'timeout' | 'disabled'

export interface ProactiveJudgeAdvice extends ProactiveJudgeRawResult {
  status: ProactiveJudgeAdviceStatus
}

export interface ProactiveJudgePolicy {
  enabled: boolean
  timeoutMs: number
  maxCallsPerHour: number
  minConfidence: number
  minUsefulness: number
  minNovelty: number
  maxInterruptionCost: number
  maxSocialRisk: number
  maxSuggestedDelayMs: number
}

export interface ProactiveJudgeInput {
  groupId: number
  messageRowId: number
  senderId: number
  senderNickname: string
  segments: ParsedSegment[]
  recentMessages?: ProactiveJudgeRecentMessage[]
  createdAt: Date
  replyProbability: number
}

export interface ProactiveJudgeRecentMessage {
  messageRowId: number
  senderId: number
  content: string
  createdAt: string
}

export interface ProactiveJudge {
  evaluate(input: ProactiveJudgeInput): Promise<ProactiveJudgeAdvice>
}

interface ProactiveJudgeOptions {
  policy?: ProactiveJudgePolicy
  client?: Pick<OpenAI.Chat.Completions, 'create'>
  model?: string
}

const rawJudgeSchema = z.strictObject({
  shouldSpeak: z.boolean(),
  usefulness: z.number(),
  novelty: z.number(),
  confidence: z.number(),
  interruptionCost: z.number(),
  socialRisk: z.number(),
  suggestedDelayMs: z.number().optional(),
  reason: z.string(),
})

const PROACTIVE_JUDGE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'proactive_judge',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        shouldSpeak: { type: 'boolean' },
        usefulness: { type: 'number' },
        novelty: { type: 'number' },
        confidence: { type: 'number' },
        interruptionCost: { type: 'number' },
        socialRisk: { type: 'number' },
        suggestedDelayMs: { type: 'number' },
        reason: { type: 'string' },
      },
      required: [
        'shouldSpeak',
        'usefulness',
        'novelty',
        'confidence',
        'interruptionCost',
        'socialRisk',
        'suggestedDelayMs',
        'reason',
      ],
    },
  },
} as const

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function trimReason(reason: string): string {
  return reason.trim().slice(0, PROACTIVE_JUDGE_REASON_LIMIT)
}

function failClosed(status: Exclude<ProactiveJudgeAdviceStatus, 'valid'>, reason: string): ProactiveJudgeAdvice {
  return {
    status,
    shouldSpeak: false,
    usefulness: 0,
    novelty: 0,
    confidence: 0,
    interruptionCost: 1,
    socialRisk: 1,
    reason: trimReason(reason),
  }
}

export function createDisabledProactiveJudgeAdvice(reason = 'proactive judge disabled'): ProactiveJudgeAdvice {
  return failClosed('disabled', reason)
}

export function createInvalidProactiveJudgeAdvice(reason = 'proactive judge failed'): ProactiveJudgeAdvice {
  return failClosed('invalid', reason)
}

export function normalizeProactiveJudgeResult(
  raw: unknown,
  policy: Pick<ProactiveJudgePolicy, 'maxSuggestedDelayMs'>,
): ProactiveJudgeAdvice {
  const parsed = rawJudgeSchema.safeParse(raw)
  if (!parsed.success) {
    return failClosed('invalid', 'proactive judge returned malformed schema')
  }

  const result = parsed.data
  if (!Number.isFinite(result.suggestedDelayMs ?? 0) || (result.suggestedDelayMs ?? 0) < 0) {
    return failClosed('invalid', 'proactive judge returned invalid suggestedDelayMs')
  }

  return {
    status: 'valid',
    shouldSpeak: result.shouldSpeak,
    usefulness: clampProbability(result.usefulness),
    novelty: clampProbability(result.novelty),
    confidence: clampProbability(result.confidence),
    interruptionCost: clampProbability(result.interruptionCost),
    socialRisk: clampProbability(result.socialRisk),
    suggestedDelayMs: result.suggestedDelayMs == null
      ? undefined
      : Math.min(Math.floor(result.suggestedDelayMs), policy.maxSuggestedDelayMs),
    reason: trimReason(result.reason),
  }
}

function stripJsonFence(content: string): string {
  return content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

export function parseProactiveJudgeContent(
  content: string,
  policy: Pick<ProactiveJudgePolicy, 'maxSuggestedDelayMs'>,
): ProactiveJudgeAdvice {
  const stripped = stripJsonFence(content.trim())
  try {
    return normalizeProactiveJudgeResult(JSON.parse(stripped), policy)
  } catch {
    try {
      return normalizeProactiveJudgeResult(JSON.parse(jsonrepair(stripped)), policy)
    } catch {
      return failClosed('invalid', 'proactive judge returned invalid json')
    }
  }
}

function buildJudgeUserContent(input: ProactiveJudgeInput): string {
  return JSON.stringify({
    groupId: input.groupId,
    messageRowId: input.messageRowId,
    senderId: input.senderId,
    senderNickname: input.senderNickname,
    createdAt: input.createdAt.toISOString(),
    replyProbability: clampProbability(input.replyProbability),
    text: segmentsToPlainText(input.segments).trim(),
    recentMessages: input.recentMessages ?? [],
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function createProactiveJudge(options: ProactiveJudgeOptions = {}): ProactiveJudge {
  const policy = options.policy ?? config.proactiveJudge
  const provider = config.llm.providers[config.llm.defaultProvider]
  const client = options.client ?? new OpenAI({ baseURL: provider.url, apiKey: provider.apiKey }).chat.completions
  const model = options.model ?? config.llm.defaultModel

  return {
    async evaluate(input) {
      if (!policy.enabled) {
        return createDisabledProactiveJudgeAdvice()
      }

      const response = await withTimeout(
        client.create({
          model,
          temperature: 0.2,
          response_format: PROACTIVE_JUDGE_RESPONSE_FORMAT as any,
          messages: [
            { role: 'system', content: loadPrompt('./prompts/proactive-judge.md') },
            { role: 'user', content: buildJudgeUserContent(input) },
          ],
        }).catch(() => null),
        policy.timeoutMs,
      )
      if (response === 'timeout') {
        return failClosed('timeout', 'proactive judge timed out')
      }
      if (!response) {
        return failClosed('invalid', 'proactive judge request failed')
      }

      const content = response.choices[0]?.message.content
      if (typeof content !== 'string' || !content.trim()) {
        return failClosed('invalid', 'proactive judge returned empty response')
      }
      return parseProactiveJudgeContent(content, policy)
    },
  }
}
