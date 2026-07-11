import { createHash } from 'node:crypto'

export interface GroupUploadNotice {
  time: number
  group_id: number
  user_id: number
  file: { id: string; name: string; size: number; busid: number }
}

/**
 * group_upload notice 没有真实 message_id。用 notice 稳定字段生成负数 ledger id：
 * 可去重、不会和 QQ 的正数消息号相撞，也明确表示不能拿去 reply。
 */
export function groupUploadSyntheticMessageId(notice: GroupUploadNotice): number {
  const digest = createHash('sha256')
    .update(`${notice.group_id}:${notice.user_id}:${notice.time}:${notice.file.id}`)
    .digest('hex')
    .slice(0, 13)
  return -Math.max(1, Number.parseInt(digest, 16))
}
