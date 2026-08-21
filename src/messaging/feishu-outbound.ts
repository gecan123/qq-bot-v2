import type { DeliveryRequest, DeliveryResult } from './message-delivery.js'

interface FeishuApiResult {
  code?: number
  message?: string
  messageId?: string
}

export interface FeishuMessageApi {
  uploadImage(bytes: Buffer): Promise<string>
  create(input: {
    receiveId: string
    receiveIdType: 'chat_id'
    msgType: string
    content: string
    uuid: string
  }): Promise<FeishuApiResult>
  reply(input: {
    messageId: string
    msgType: string
    content: string
    uuid: string
  }): Promise<FeishuApiResult>
}

export async function sendFeishuDelivery(
  api: FeishuMessageApi,
  request: DeliveryRequest,
): Promise<DeliveryResult> {
  if (request.target.platform !== 'feishu') {
    return { status: 'failed', code: 'invalid_target', error: 'Feishu adapter requires a Feishu target' }
  }
  if (request.filePath || request.platformPayload) {
    return { status: 'failed', code: 'unsupported_content', error: 'Unsupported Feishu outbound content' }
  }
  try {
    const imageKey = request.imageBytes ? await api.uploadImage(request.imageBytes) : undefined
    const payload = buildContent(request.text, request.mentionExternalId, imageKey)
    const response = request.replyToExternalId
      ? await api.reply({
          messageId: request.replyToExternalId,
          msgType: payload.msgType,
          content: payload.content,
          uuid: request.actionId,
        })
      : await api.create({
          receiveId: request.target.externalId,
          receiveIdType: 'chat_id',
          msgType: payload.msgType,
          content: payload.content,
          uuid: request.actionId,
        })
    if (response.code != null && response.code !== 0) {
      return {
        status: 'failed',
        code: String(response.code),
        error: response.message ?? 'Feishu API rejected the message',
      }
    }
    if (!response.messageId) {
      return { status: 'delivery_unknown', code: 'missing_message_id', error: 'Feishu returned no message id' }
    }
    return { status: 'sent', providerMessageId: response.messageId }
  } catch (error) {
    const explicit = explicitFeishuError(error)
    if (explicit) return { status: 'failed', code: String(explicit.code), error: explicit.message }
    return {
      status: 'delivery_unknown',
      code: 'transport_error',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function buildContent(text?: string, mentionId?: string, imageKey?: string) {
  if (!mentionId && !imageKey) {
    return { msgType: 'text', content: JSON.stringify({ text: text ?? '' }) }
  }
  const line: object[] = []
  if (mentionId) line.push({ tag: 'at', user_id: mentionId })
  if (text) line.push({ tag: 'text', text })
  if (imageKey) line.push({ tag: 'img', image_key: imageKey })
  return {
    msgType: 'post',
    content: JSON.stringify({ zh_cn: { title: '', content: [line] } }),
  }
}

function explicitFeishuError(error: unknown): { code: number; message: string } | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; message?: unknown }
  return typeof candidate.code === 'number' && candidate.code !== 0
    ? { code: candidate.code, message: String(candidate.message ?? 'Feishu API rejected the message') }
    : null
}
