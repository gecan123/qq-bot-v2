import type { IncomingMessage } from './pipeline.js'
import type { ParsedSegment } from '../types/message-segments.js'
import type { Message } from '../generated/prisma/client.js'
import {
  freezeResolvedTextIfUnset,
  getMessageById,
  getMessageBySceneMessageId,
  type MessageSceneKind,
} from '../database/messages.js'
import { resolveMessage } from '../media/message-resolver.js'
import { config } from '../config/index.js'
import { segmentsToPlainText } from '../utils/segment-text.js'

/**
 * Phase E: context-builder 大半内容已退役 — 永续上下文的真身现在是
 * src/agent/agent-context.ts 的 AgentContext, 摄入由
 * src/agent/scene-message-ingestor.ts 负责。
 *
 * 这个模块只剩下「从 IncomingMessage 中提取触发文本」一项职责, 因为
 * trigger text 本身需要做媒体 resolve + freeze, 是 reply-generator 切到
 * AgentContext 之前的最后一步。
 */

export interface ContextBuildOptions {
  mediaDeadlineAt?: number
}

function getRemainingBudget(deadlineAt?: number): number {
  if (deadlineAt == null) return config.replyMediaTimeoutMs
  return Math.max(deadlineAt - Date.now(), 0)
}

async function getStableResolvedText(
  message: Message,
  options: ContextBuildOptions = {},
): Promise<string> {
  const frozen = message.resolvedText?.trim()
  if (frozen) return frozen

  const resolvedSegments = await resolveMessage(message, { timeoutMs: getRemainingBudget(options.mediaDeadlineAt) })
  const resolvedText = segmentsToPlainText(resolvedSegments)
  await freezeResolvedTextIfUnset(message.id, resolvedText)
  return resolvedText
}

export function extractTriggerText(segments: ParsedSegment[]): string {
  return segmentsToPlainText(segments.filter((s) => s.type !== 'reply'))
}

/**
 * 取触发消息的"稳定可见文本":
 * - messages 表里有这条 row → 走 resolvedText (冻结过的优先), 否则即时 resolve+freeze
 * - 没有 row (新消息还没入库) → 退到 fallbackSegments
 */
export async function extractResolvedTriggerText(
  groupId: number,
  messageId: number,
  fallbackSegments: ParsedSegment[],
  options: ContextBuildOptions = {},
  scene?: { sceneKind?: IncomingMessage['sceneKind']; sceneExternalId?: string | number },
): Promise<string> {
  const dbMsg = scene?.sceneKind === 'qq_private'
    ? await getMessageBySceneMessageId({
        sceneKind: scene.sceneKind as MessageSceneKind,
        sceneExternalId: scene.sceneExternalId ?? groupId,
        messageId,
      })
    : await getMessageById(groupId, messageId)
  if (!dbMsg) return extractTriggerText(fallbackSegments)
  return getStableResolvedText(dbMsg, options)
}
