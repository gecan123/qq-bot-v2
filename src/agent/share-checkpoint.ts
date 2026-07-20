import type { AgentMessage } from './agent-context.types.js'
import type { ReactToolOutcome } from './react-kernel.js'

export interface ActiveGroupShareTarget {
  groupId: number
  groupName: string | null
  residentHint: string
}

export interface ShareCheckpointCandidate {
  key: string
  cooldownKey: string
  summary: string
  sourceTool: string
}

interface ShareCheckpointPayload {
  event: 'share_checkpoint'
  candidateKey: string
  cooldownKey: string
  createdAt: string
  sourceTool: string
  summary: string
  activeGroups: Array<{
    groupId: number
    groupName: string | null
    residentHint: string
  }>
  instruction: string
}

const SHARE_CHECKPOINT_INSTRUCTION = [
  '这是一次有边界的分享选择，不是发言任务。',
  '判断这项新成果是否适合某个 active 群，并先排除私人内容、敏感信息和近期重复内容。',
  '适合分享时，先按需读取目标群最近上下文和 group style，再 qq_conversation open / send_message；不适合就保留私下并继续当前 Goal。',
  '不要为了完成 checkpoint 勉强发言，同一 candidateKey 只判断一次。',
].join('')

export const SHARE_CHECKPOINT_COOLDOWN_MS = 2 * 60 * 60_000

export function selectShareCheckpointCandidate(
  outcomes: readonly ReactToolOutcome[],
  messages: readonly AgentMessage[],
  now = new Date(),
): ShareCheckpointCandidate | null {
  for (let index = outcomes.length - 1; index >= 0; index--) {
    const outcome = outcomes[index]!
    const candidate = outcome.shareCandidate
    if (!outcome.ok || !outcome.progress || candidate == null) continue
    const key = normalizeKey(candidate.key)
    const cooldownKey = normalizeKey(candidate.cooldownKey)
    const summary = candidate.summary.trim().slice(0, 1_000)
    if (!key || !cooldownKey || !summary) continue
    if (hasRecentShareCheckpoint(messages, key, cooldownKey, now)) continue
    return {
      key,
      cooldownKey,
      summary,
      sourceTool: outcome.toolName,
    }
  }
  return null
}

export function renderShareCheckpoint(
  candidate: ShareCheckpointCandidate,
  targets: readonly ActiveGroupShareTarget[],
  now = new Date(),
): string {
  const payload: ShareCheckpointPayload = {
    event: 'share_checkpoint',
    candidateKey: candidate.key,
    cooldownKey: candidate.cooldownKey,
    createdAt: now.toISOString(),
    sourceTool: candidate.sourceTool.slice(0, 100),
    summary: candidate.summary.slice(0, 1_000),
    activeGroups: [...targets]
      .sort((left, right) => left.groupId - right.groupId)
      .map((target) => ({
        groupId: target.groupId,
        groupName: target.groupName,
        residentHint: target.residentHint.slice(0, 500),
      })),
    instruction: SHARE_CHECKPOINT_INSTRUCTION,
  }
  return JSON.stringify(payload)
}

function hasRecentShareCheckpoint(
  messages: readonly AgentMessage[],
  candidateKey: string,
  cooldownKey: string,
  now: Date,
): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user' || typeof message.content !== 'string') continue
    if (!message.content.includes('"event":"share_checkpoint"')) continue
    try {
      const payload = JSON.parse(message.content) as {
        event?: unknown
        candidateKey?: unknown
        cooldownKey?: unknown
        createdAt?: unknown
      }
      if (payload.event === 'share_checkpoint' && payload.candidateKey === candidateKey) return true
      if (payload.event !== 'share_checkpoint' || payload.cooldownKey !== cooldownKey) continue
      if (typeof payload.createdAt !== 'string') continue
      const createdAtMs = Date.parse(payload.createdAt)
      if (Number.isFinite(createdAtMs) && now.getTime() - createdAtMs < SHARE_CHECKPOINT_COOLDOWN_MS) {
        return true
      }
    } catch {
      // 普通用户文本可能包含相同片段；不是合法 runtime marker 就忽略。
    }
  }
  return false
}

function normalizeKey(value: string): string {
  return value.trim().slice(0, 500)
}
