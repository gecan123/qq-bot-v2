import { prisma } from '../database/client.js'
import type { EventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { ensureMessageReadyForAgent } from '../media/ensure-message-ready.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('REPLAY')

/**
 * 启动时把 lastWakeAt 之后落库的群消息 (target group only) 一次性 enqueue 进 BotEventQueue。
 *
 * lastWakeAt 含义: bot 上次成功 drain 一条消息的时刻。重启后只回放此后的消息——
 * 之前的已经在 snapshot 的 messages 数组里了。
 *
 * 如果 lastWakeAt 是 null (从空启动), 不回放任何消息——避免新 bot 首次启动就被
 * 几千条历史消息淹没。补拉历史走 bot/core.ts 的 backfill (只入库, 不进 context)。
 */
export interface ReplayMissedDeps {
  eventQueue: EventQueue<BotEvent>
  selfNumber: number
}

export async function replayMissedMessages(
  lastWakeAt: Date | null,
  deps: ReplayMissedDeps,
): Promise<{ enqueued: number }> {
  if (!lastWakeAt) {
    log.info('lastWakeAt is null; skipping replay')
    return { enqueued: 0 }
  }

  const groupId = config.botTargetGroupId
  const rows = await prisma.message.findMany({
    where: {
      sceneKind: 'qq_group',
      groupId: BigInt(groupId),
      createdAt: { gt: lastWakeAt },
      senderId: { not: BigInt(deps.selfNumber) },
    },
    orderBy: { createdAt: 'asc' },
  })

  for (const row of rows) {
    const ready = await ensureMessageReadyForAgent(row)
    const segments = row.content as unknown as Array<{ type: string; targetId?: string }>
    const mentionedSelf = segments.some(
      (seg) => seg.type === 'at' && seg.targetId === String(deps.selfNumber),
    )
    deps.eventQueue.enqueue({
      type: 'napcat_message',
      messageRowId: row.id,
      groupId,
      messageId: Number(row.messageId),
      senderId: Number(row.senderId),
      senderNickname: row.senderGroupNickname ?? row.senderNickname ?? String(row.senderId),
      mentionedSelf,
      sentAt: row.sentAt ?? row.createdAt,
      renderedText: ready.renderedText,
    })
  }

  log.info({ enqueued: rows.length, since: lastWakeAt.toISOString() }, '回放关机期间消息')
  return { enqueued: rows.length }
}
