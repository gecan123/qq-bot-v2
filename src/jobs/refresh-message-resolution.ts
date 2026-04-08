import { getRecentMessagesReferencingMedia, updateResolvedText } from '../database/messages.js'
import { config } from '../config/index.js'
import type { Message } from '../generated/prisma/client.js'
import { createLogger } from '../logger.js'
import { resolveMessage } from '../media/message-resolver.js'
import { segmentsToPlainText } from '../utils/segment-text.js'
import type { Job } from '../queue/types.js'

export interface RefreshMessageResolutionData {
  mediaId: number
}

interface RefreshResolvedTextDeps {
  now?: () => Date
  findMessages?: (mediaId: number, since: Date) => Promise<Message[]>
  resolve?: (message: Message) => Promise<unknown[]>
  updateMessage?: (messageId: number, resolvedText: string) => Promise<void>
  windowMinutes?: number
}

const log = createLogger('JOB_RESOLVE')

export async function refreshResolvedTextForMedia(
  mediaId: number,
  deps: RefreshResolvedTextDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => new Date())
  const findMessages = deps.findMessages ?? getRecentMessagesReferencingMedia
  const resolve = deps.resolve ?? ((message: Message) => resolveMessage(message, { timeoutMs: 0 }))
  const updateMessage = deps.updateMessage ?? updateResolvedText
  const windowMinutes = deps.windowMinutes ?? config.messageResolutionRefreshWindowMinutes

  const since = new Date(now().getTime() - windowMinutes * 60 * 1000)
  const messages = await findMessages(mediaId, since)

  for (const message of messages) {
    const resolvedSegments = await resolve(message)
    const resolvedText = segmentsToPlainText(resolvedSegments as any)
    await updateMessage(message.id, resolvedText)
  }
}

export async function handleRefreshMessageResolution(
  job: Job<'refresh-message-resolution', RefreshMessageResolutionData>,
): Promise<void> {
  log.debug({ jobId: job.id, mediaId: job.data.mediaId }, '队列任务开始刷新消息 resolved_text')
  await refreshResolvedTextForMedia(job.data.mediaId)
}
