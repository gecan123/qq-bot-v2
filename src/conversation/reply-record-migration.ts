import { listLegacyAssistantTurns } from './assistant-turn-store.js'
import {
  findReplyRecordByReplyIntentId,
  upsertReplyRecordFromLegacyAssistantTurn,
} from './reply-record-store.js'
import { createLogger } from '../logger.js'
import type { AssistantTurnRecord } from './assistant-turn-store.js'
import { parseSenderReplyScopeKey } from './reply-scope.js'
import type { RootRuntimeManager } from '../runtime/root-runtime.js'
import { makeMentionReplyIntentId } from '../runtime/types.js'

const log = createLogger('REPLY_MIGRATION')

function resolveLegacySenderId(turn: AssistantTurnRecord): number | null {
  if (turn.mentionUserId != null) {
    return turn.mentionUserId
  }

  return parseSenderReplyScopeKey(turn.senderThreadKey)
}

function getNormalizedReplyIntentId(turn: AssistantTurnRecord): string {
  return turn.triggerMessageRowId
    ? makeMentionReplyIntentId(turn.groupId, turn.triggerMessageRowId)
    : turn.replyIntentId
}

export async function migrateLegacyAssistantTurnsToReplyRecords(options: {
  groupIds: number[]
  rootRuntime?: RootRuntimeManager
  listLegacyAssistantTurnsFn?: typeof listLegacyAssistantTurns
  findReplyRecordByReplyIntentIdFn?: typeof findReplyRecordByReplyIntentId
  upsertReplyRecordFromLegacyAssistantTurnFn?: typeof upsertReplyRecordFromLegacyAssistantTurn
}): Promise<{ migratedCount: number; projectedSentCount: number }> {
  let migratedCount = 0
  let projectedSentCount = 0

  const listLegacyAssistantTurnsFn = options.listLegacyAssistantTurnsFn ?? listLegacyAssistantTurns
  const findReplyRecordByReplyIntentIdFn =
    options.findReplyRecordByReplyIntentIdFn ?? findReplyRecordByReplyIntentId
  const upsertReplyRecordFromLegacyAssistantTurnFn =
    options.upsertReplyRecordFromLegacyAssistantTurnFn ?? upsertReplyRecordFromLegacyAssistantTurn

  const legacyTurns = await listLegacyAssistantTurnsFn(options.groupIds)
  for (const turn of legacyTurns) {
    const runtimeKey = `qq_group:${turn.groupId}`
    const normalizedReplyIntentId = getNormalizedReplyIntentId(turn)
    const existing =
      (await findReplyRecordByReplyIntentIdFn(runtimeKey, normalizedReplyIntentId)) ??
      (normalizedReplyIntentId === turn.replyIntentId
        ? null
        : await findReplyRecordByReplyIntentIdFn(runtimeKey, turn.replyIntentId))
    if (!existing) {
      await upsertReplyRecordFromLegacyAssistantTurnFn(turn)
      migratedCount++
    }

    if (turn.status === 'sent') {
      const senderId = resolveLegacySenderId(turn)
      if (senderId != null) {
        await options.rootRuntime?.markPassiveReplyDelivered({
          groupId: turn.groupId,
          senderId,
          incorporatedMessageRowId: turn.incorporatedMessageRowId,
          text: turn.text,
        })
        projectedSentCount++
      }
    }
  }

  log.info(
    {
      migratedCount,
      projectedSentCount,
    },
    'legacy assistant_turns migrated into reply_records',
  )

  return {
    migratedCount,
    projectedSentCount,
  }
}
