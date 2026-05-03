import { prisma } from '../database/client.js'
import type { BotEvent } from './event.js'
import { ensureMessageReadyForAgent } from '../media/ensure-message-ready.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('REPLAY')

/**
 * 启动时把 lastWakeAt 之后落库的群消息 + 私聊消息一次性 enqueue 进 BotEventQueue。
 *
 * lastWakeAt 含义: bot 上次成功 drain 一条消息的时刻。重启后只回放此后的消息——
 * 之前的已经在 snapshot 的 messages 数组里了。
 *
 * 如果 lastWakeAt 是 null (从空启动), 不回放任何消息——避免新 bot 首次启动就被
 * 几千条历史消息淹没。补拉历史走 bot/core.ts 的 backfill (只入库, 不进 context)。
 *
 * 关键: replay 在 NapCat connect 之后跑 (D2 ordering), 所以可能与 live event 重叠.
 * 调用方传入的 enqueueMessageEvent 必须按 messageRowId 去重, 避免同一条消息被同时
 * live + replay 入队两次. 见 src/index.ts 的 enqueueMessageEvent 实现.
 */
export interface ReplayMissedDeps {
  /**
   * 入队函数. 必须按 messageRowId 去重并返回:
   *   true  → 真入队
   *   false → 已被 live 路径入过队, skip
   * 这个 hook 是与 src/index.ts 的 enqueueMessageEvent 绑定的, 不要在 replay 里另起一份去重 set.
   */
  enqueueMessageEvent: (event: BotEvent) => boolean
  selfNumber: number
}

export async function replayMissedMessages(
  lastWakeAt: Date | null,
  deps: ReplayMissedDeps,
): Promise<{ enqueued: number; skippedDuplicates: number }> {
  if (!lastWakeAt) {
    log.info('lastWakeAt is null; skipping replay')
    return { enqueued: 0, skippedDuplicates: 0 }
  }

  const groupIds = config.botTargetGroupIds.map((id) => BigInt(id))
  const peerIds = config.botTargetPrivateUserIds.map((id) => String(id))
  const orFilters: Array<Record<string, unknown>> = []
  if (groupIds.length > 0) {
    orFilters.push({ sceneKind: 'qq_group', groupId: { in: groupIds } })
  }
  if (peerIds.length > 0) {
    orFilters.push({ sceneKind: 'qq_private', sceneExternalId: { in: peerIds } })
  }
  if (orFilters.length === 0) return { enqueued: 0, skippedDuplicates: 0 }

  const rows = await prisma.message.findMany({
    where: {
      createdAt: { gt: lastWakeAt },
      senderId: { not: BigInt(deps.selfNumber) },
      OR: orFilters,
    },
    orderBy: { createdAt: 'asc' },
  })

  let enqueued = 0
  let skipped = 0
  for (const row of rows) {
    const ready = await ensureMessageReadyForAgent(row)
    const segments = row.content as unknown as Array<{ type: string; targetId?: string }>
    const mentionedSelf = segments.some(
      (seg) => seg.type === 'at' && seg.targetId === String(deps.selfNumber),
    )

    let event: BotEvent
    if (row.sceneKind === 'qq_private') {
      const peerId = Number(row.sceneExternalId)
      event = {
        type: 'napcat_private_message',
        messageRowId: row.id,
        peerId,
        messageId: Number(row.messageId),
        senderId: Number(row.senderId),
        senderNickname: row.senderNickname ?? String(row.senderId),
        mentionedSelf: true,
        sentAt: row.sentAt ?? row.createdAt,
        renderedText: ready.renderedText,
      }
    } else {
      const groupIdNum = row.groupId == null ? 0 : Number(row.groupId)
      event = {
        type: 'napcat_message',
        messageRowId: row.id,
        groupId: groupIdNum,
        groupName: row.groupName ?? undefined,
        messageId: Number(row.messageId),
        senderId: Number(row.senderId),
        senderNickname: row.senderGroupNickname ?? row.senderNickname ?? String(row.senderId),
        mentionedSelf,
        sentAt: row.sentAt ?? row.createdAt,
        renderedText: ready.renderedText,
      }
    }

    const accepted = deps.enqueueMessageEvent(event)
    if (accepted) enqueued++
    else skipped++
  }

  log.info(
    {
      enqueued,
      skippedDuplicates: skipped,
      since: lastWakeAt.toISOString(),
    },
    '回放关机期间消息',
  )
  return { enqueued, skippedDuplicates: skipped }
}
