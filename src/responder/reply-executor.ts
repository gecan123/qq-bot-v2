import { napcat } from '../bot/napcat.js'
import { createLogger } from '../logger.js'

interface NapcatSegment {
  type: string
  data: Record<string, string | number | boolean>
}

const RETRY_LIMIT = 2
const RETRY_DELAY_MS = 1000
const log = createLogger('SEND')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function sendGroupReply(groupId: number, segments: NapcatSegment[]): Promise<void> {
  const preview = segments
    .filter((s) => s.type === 'text')
    .map((s) => String(s.data.text ?? ''))
    .join('')
    .slice(0, 60)

  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    try {
      await napcat.send_group_msg({ group_id: groupId, message: segments as never })
      log.info({ groupId, preview }, '消息发送成功')
      return
    } catch (error) {
      log.warn({ groupId, preview, attempt, error }, '消息发送失败')
      if (attempt < RETRY_LIMIT) await sleep(RETRY_DELAY_MS)
    }
  }

  log.error({ groupId, preview }, `消息发送失败，已重试 ${RETRY_LIMIT} 次`)
}
