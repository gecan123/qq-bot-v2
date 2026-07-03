import { prisma } from '../database/client.js'
import type { BotEvent } from './event.js'
import type { Message } from '../generated/prisma/client.js'
import { ensureMessageReadyForAgent as defaultEnsureReady } from '../media/ensure-message-ready.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import type { MailboxCursors } from './mailbox.js'

const log = createLogger('REPLAY')

/**
 * 启动时按每个 mailbox 的 message-row cursor 回放尚未披露的群消息 + 私聊消息。
 *
 * 已有来源按独立 row cursor 判断；旧 snapshot 或首次出现的新来源回退到 lastWakeAt。
 * 两者都不存在时视为冷启动，不回放历史，避免新 bot 被已有消息淹没。
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
  /**
   * 测试可注入. 默认走 src/media/ensure-message-ready.ts 的实现 (等待媒体描述 + 冻结 resolved_text).
   */
  ensureReady?: (message: Message) => Promise<{ renderedText: string; fromFrozen: boolean }>
}

export interface ReplayCheckpoint {
  mailboxCursors: Readonly<MailboxCursors>
  /** 旧 snapshot 兼容边界，也用于尚未出现 cursor 的新来源。 */
  legacyLastWakeAt: Date | null
}

export async function replayMissedMessages(
  checkpoint: ReplayCheckpoint,
  deps: ReplayMissedDeps,
): Promise<{ enqueued: number; skippedDuplicates: number }> {
  const cursorEntries = Object.entries(checkpoint.mailboxCursors)
  if (cursorEntries.length === 0 && !checkpoint.legacyLastWakeAt) {
    log.info('mailbox cursors and lastWakeAt are empty; skipping replay')
    return { enqueued: 0, skippedDuplicates: 0 }
  }

  const groupIds = config.botTargetGroupIds.map((id) => BigInt(id))
  const sourceFilters: Array<Record<string, unknown>> = []
  for (const groupId of groupIds) {
    const key = `qq_group:${groupId}`
    const cursor = checkpoint.mailboxCursors[key]
    if (cursor != null) {
      sourceFilters.push({ sceneKind: 'qq_group', groupId, id: { gt: cursor } })
    } else if (checkpoint.legacyLastWakeAt) {
      sourceFilters.push({
        sceneKind: 'qq_group',
        groupId,
        createdAt: { gt: checkpoint.legacyLastWakeAt },
      })
    }
  }

  for (const [key, cursor] of cursorEntries) {
    if (!key.startsWith('qq_private:')) continue
    sourceFilters.push({
      sceneKind: 'qq_private',
      sceneExternalId: key.slice('qq_private:'.length),
      id: { gt: cursor },
    })
  }
  // 任意好友的新私聊来源没有预注册 cursor，以 legacy 时间边界发现。
  if (checkpoint.legacyLastWakeAt) {
    sourceFilters.push({
      sceneKind: 'qq_private',
      createdAt: { gt: checkpoint.legacyLastWakeAt },
    })
  }

  if (sourceFilters.length === 0) {
    log.info('no replayable mailbox sources')
    return { enqueued: 0, skippedDuplicates: 0 }
  }

  const rows = await prisma.message.findMany({
    where: {
      senderId: { not: BigInt(deps.selfNumber) },
      OR: sourceFilters,
    },
    orderBy: { id: 'asc' },
  })

  const ensureReady = deps.ensureReady ?? defaultEnsureReady
  let enqueued = 0
  let skipped = 0
  for (const row of rows) {
    const sourceKey = row.sceneKind === 'qq_private'
      ? `qq_private:${row.sceneExternalId}`
      : `qq_group:${String(row.groupId)}`
    const cursor = checkpoint.mailboxCursors[sourceKey]
    const isAfterSourceBoundary = cursor != null
      ? row.id > cursor
      : checkpoint.legacyLastWakeAt != null && row.createdAt > checkpoint.legacyLastWakeAt
    if (!isAfterSourceBoundary) continue

    const ready = await ensureReady(row)
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
      cursorSources: cursorEntries.length,
      legacySince: checkpoint.legacyLastWakeAt?.toISOString() ?? null,
    },
    '回放关机期间消息',
  )
  return { enqueued, skippedDuplicates: skipped }
}
