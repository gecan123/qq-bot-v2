import type { GroupPolicy } from '../config/group-policies.js'
import { prisma } from '../database/client.js'
import { ensureMessageReadyForAgent } from '../media/ensure-message-ready.js'
import type { BotEvent } from '../agent/event.js'
import { createLogger } from '../logger.js'

const log = createLogger('MAILBOX_WATCHER')

export interface DatabaseMailboxWatcher {
  start(): void
  stop(): Promise<void>
  cursor(): number
}

export async function currentMessageHighWater(): Promise<number> {
  const result = await prisma.message.aggregate({ _max: { id: true } })
  return result._max.id ?? 0
}

export function createDatabaseMailboxWatcher(input: {
  startAfterRowId: number
  pollMs: number
  selfNumber: number
  groupPolicies: readonly GroupPolicy[]
  enqueue: (event: BotEvent) => void | Promise<void>
}): DatabaseMailboxWatcher {
  const policies = new Map(input.groupPolicies.map((policy) => [policy.id, policy]))
  let cursor = input.startAfterRowId
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let polling = false
  let activePoll: Promise<void> | null = null

  const schedule = (delayMs: number): void => {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      activePoll = poll().finally(() => {
        activePoll = null
      })
    }, delayMs)
  }

  const poll = async (): Promise<void> => {
    if (stopped || polling) return
    polling = true
    try {
      const rows = await prisma.message.findMany({
        where: {
          id: { gt: cursor },
          senderId: { not: BigInt(input.selfNumber) },
          sceneKind: { in: ['qq_group', 'qq_private'] },
        },
        orderBy: { id: 'asc' },
        take: 200,
      })
      for (const row of rows) {
        if (row.sceneKind === 'qq_group') {
          const groupId = row.groupId == null ? null : Number(row.groupId)
          if (groupId == null || !Number.isSafeInteger(groupId)) {
            cursor = row.id
            continue
          }
          const policy = policies.get(groupId)
          if (!policy) {
            cursor = row.id
            continue
          }
          const mentionedSelf = messageMentions(row.content, input.selfNumber)
          if (policy.participation === 'mentions' && !mentionedSelf) {
            cursor = row.id
            continue
          }
          const ready = await ensureMessageReadyForAgent(row)
          await input.enqueue({
            type: 'napcat_message',
            messageRowId: row.id,
            groupId,
            groupName: row.groupName ?? undefined,
            messageId: Number(row.messageId),
            senderId: Number(row.senderId),
            senderNickname: row.senderGroupNickname ?? row.senderNickname ?? String(row.senderId),
            mentionedSelf,
            sentAt: row.sentAt ?? row.createdAt,
            renderedText: ready.renderedText,
          })
          cursor = row.id
          continue
        }

        const peerId = Number(row.sceneExternalId)
        if (!Number.isSafeInteger(peerId) || peerId <= 0) {
          cursor = row.id
          continue
        }
        const ready = await ensureMessageReadyForAgent(row)
        await input.enqueue({
          type: 'napcat_private_message',
          messageRowId: row.id,
          peerId,
          messageId: Number(row.messageId),
          senderId: Number(row.senderId),
          senderNickname: row.senderNickname ?? String(row.senderId),
          mentionedSelf: true,
          sentAt: row.sentAt ?? row.createdAt,
          renderedText: ready.renderedText,
        })
        cursor = row.id
      }
      schedule(rows.length === 200 ? 0 : input.pollMs)
    } catch (error) {
      log.error({ error, cursor }, 'database_mailbox_poll_failed')
      schedule(input.pollMs)
    } finally {
      polling = false
    }
  }

  return {
    start() {
      stopped = false
      schedule(0)
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      await activePoll
    },
    cursor: () => cursor,
  }
}

function messageMentions(content: unknown, selfNumber: number): boolean {
  if (!Array.isArray(content)) return false
  return content.some((segment) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false
    const value = segment as Record<string, unknown>
    return value.type === 'at' && value.targetId === String(selfNumber)
  })
}
