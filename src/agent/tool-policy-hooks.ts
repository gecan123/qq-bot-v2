import type { AfterToolHook, BeforeToolHook } from './tool.js'
import { createLogger } from '../logger.js'
import { predictAiTone, type AiTonePrediction, type AiTonePredictor } from './tools/ai-tone.js'

const log = createLogger('TOOL_POLICY_HOOKS')

const DEFAULT_AI_TONE_THRESHOLD = 0.75
const DEFAULT_MIN_TEXT_LENGTH = 12
const DEFAULT_MAX_CONSECUTIVE_BLOCKS = 2

export type AiTonePrecheckDecision = 'allowed' | 'blocked' | 'allowed_after_limit'

export interface AiTonePrecheckLogEntry {
  toolCallId: string
  roundIndex: number
  targetType: 'group'
  groupId: number
  textLength: number
  prob: number
  threshold: number
  isAI: boolean
  decision: AiTonePrecheckDecision
  consecutiveBlocked: number
}

export interface GenerateImageTaskLogEntry {
  toolCallId: string
  roundIndex: number
  taskId: string
  description: string
  quality?: string
  promptPreview?: string
}

interface GroupSendAiToneHookOptions {
  predict?: AiTonePredictor
  logger?: (entry: AiTonePrecheckLogEntry) => void
  threshold?: number
  minTextLength?: number
  maxConsecutiveBlocks?: number
}

interface SendMessageHookArgs {
  target?: { type?: unknown; groupId?: unknown }
  text?: unknown
}

interface GenerateImageHookArgs {
  prompt?: unknown
  quality?: unknown
}

interface GenerateImageStartedResult {
  ok?: unknown
  status?: unknown
  taskId?: unknown
  description?: unknown
}

interface GenerateImageTaskLogHookOptions {
  logger?: (entry: GenerateImageTaskLogEntry) => void
}

export function createGenerateImageTaskLogHook(options: GenerateImageTaskLogHookOptions = {}): AfterToolHook {
  const logger = options.logger ?? ((entry) => log.info(entry, 'generate_image_task_started'))

  return ({ call, roundIndex, result }) => {
    if (call.name !== 'generate_image') return
    if (typeof result.content !== 'string') return

    const parsed = parseJsonObject(result.content) as GenerateImageStartedResult | null
    if (!parsed) return
    if (parsed.ok !== true || parsed.status !== 'started' || typeof parsed.taskId !== 'string') return

    const args = call.args as GenerateImageHookArgs
    const entry: GenerateImageTaskLogEntry = {
      toolCallId: call.id,
      roundIndex,
      taskId: parsed.taskId,
      description: typeof parsed.description === 'string' ? parsed.description : '',
      ...(typeof args.quality === 'string' ? { quality: args.quality } : {}),
      ...(typeof args.prompt === 'string' ? { promptPreview: preview(args.prompt, 160) } : {}),
    }
    logger(entry)
  }
}

export function createGroupSendAiToneHook(options: GroupSendAiToneHookOptions = {}): BeforeToolHook {
  const predict = options.predict ?? predictAiTone
  const logger = options.logger ?? ((entry) => log.info(entry, 'send_message_ai_tone_precheck'))
  const threshold = options.threshold ?? DEFAULT_AI_TONE_THRESHOLD
  const minTextLength = options.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH
  const maxConsecutiveBlocks = options.maxConsecutiveBlocks ?? DEFAULT_MAX_CONSECUTIVE_BLOCKS
  const consecutiveBlockedByGroup = new Map<number, number>()

  return async ({ call, roundIndex }) => {
    if (call.name !== 'send_message') return

    const args = call.args as SendMessageHookArgs
    if (args.target?.type !== 'group') return
    if (typeof args.target.groupId !== 'number') return
    if (typeof args.text !== 'string') return

    const textLength = Array.from(args.text).length
    if (textLength < minTextLength) return

    const prediction = await predict(args.text, threshold)
    const currentBlocked = consecutiveBlockedByGroup.get(args.target.groupId) ?? 0

    if (!prediction.isAI) {
      consecutiveBlockedByGroup.delete(args.target.groupId)
      logger(buildLogEntry({
        callId: call.id,
        roundIndex,
        groupId: args.target.groupId,
        textLength,
        prediction,
        decision: 'allowed',
        consecutiveBlocked: 0,
      }))
      return
    }

    if (currentBlocked >= maxConsecutiveBlocks) {
      logger(buildLogEntry({
        callId: call.id,
        roundIndex,
        groupId: args.target.groupId,
        textLength,
        prediction,
        decision: 'allowed_after_limit',
        consecutiveBlocked: currentBlocked,
      }))
      return
    }

    const nextBlocked = currentBlocked + 1
    consecutiveBlockedByGroup.set(args.target.groupId, nextBlocked)
    logger(buildLogEntry({
      callId: call.id,
      roundIndex,
      groupId: args.target.groupId,
      textLength,
      prediction,
      decision: 'blocked',
      consecutiveBlocked: nextBlocked,
    }))

    return {
      content: JSON.stringify({
        ok: false,
        error: 'ai_tone_precheck_failed',
        prob: roundPredictionNumber(prediction.prob),
        threshold: prediction.threshold,
        consecutiveBlocked: nextBlocked,
        instruction: '这条群聊发言 AI 味太重。请改成更短、更具体、更像群友随口说的话，然后重新调用 send_message。',
      }),
    }
  }
}

function buildLogEntry(input: {
  callId: string
  roundIndex: number
  groupId: number
  textLength: number
  prediction: AiTonePrediction
  decision: AiTonePrecheckDecision
  consecutiveBlocked: number
}): AiTonePrecheckLogEntry {
  return {
    toolCallId: input.callId,
    roundIndex: input.roundIndex,
    targetType: 'group',
    groupId: input.groupId,
    textLength: input.textLength,
    prob: roundPredictionNumber(input.prediction.prob),
    threshold: input.prediction.threshold,
    isAI: input.prediction.isAI,
    decision: input.decision,
    consecutiveBlocked: input.consecutiveBlocked,
  }
}

function roundPredictionNumber(value: number): number {
  return Math.round(value * 1000) / 1000
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function preview(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`
}
