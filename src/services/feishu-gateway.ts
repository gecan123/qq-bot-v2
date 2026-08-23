import type { Server } from 'node:http'
import {
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  normalize,
  type BotIdentity,
  type RawMessageEvent,
} from '@larksuiteoapi/node-sdk'
import { config } from '../config/index.js'
import { prisma } from '../database/client.js'
import {
  findObservedConversations,
  isMessageInConversation,
  isObservedConversation,
} from '../database/messages.js'
import { createLogger } from '../logger.js'
import type { DeliveryRequest } from '../messaging/message-delivery.js'
import { sendFeishuDelivery, type FeishuMessageApi } from '../messaging/feishu-outbound.js'
import { closeServer, startJsonServer, writeJson } from './http.js'
import { persistFeishuIncomingMessage, FEISHU_MEDIA_MAX_BYTES } from './feishu-ingress.js'
import { persistMessageRecall } from './message-recall.js'
import { authorizeFeishuDelivery } from './feishu-delivery-policy.js'
import {
  classifyFeishuReceive,
  ConversationWorkQueue,
  feishuGatewayHealth,
} from './feishu-event-routing.js'
import { withTransientRetry } from '../database/transient-retry.js'
import { recordIngressFailure } from './ingress-failure-log.js'

const log = createLogger('FEISHU_GATEWAY')
const feishu = config.feishu
let server: Server | null = null
let ws: WSClient | null = null
let queue: ConversationWorkQueue | null = null
let shuttingDown = false

async function main(): Promise<void> {
  if (!feishu) throw new Error('BOT_FEISHU_ENABLED=true is required')
  await prisma.$connect()
  const client = new Client({
    appId: feishu.appId,
    appSecret: feishu.appSecret,
    domain: Domain.Feishu,
    loggerLevel: LoggerLevel.warn,
  })
  const botIdentity = await fetchBotIdentity(client)
  queue = new ConversationWorkQueue()
  const dispatcher = createDispatcher(client, botIdentity, queue)
  ws = new WSClient({
    appId: feishu.appId,
    appSecret: feishu.appSecret,
    domain: Domain.Feishu,
    autoReconnect: true,
    handshakeTimeoutMs: 15_000,
    loggerLevel: LoggerLevel.warn,
    onReady: () => log.info({ appId: feishu.appId }, 'feishu_ws_connected'),
    onReconnecting: () => log.warn('feishu_ws_reconnecting'),
    onReconnected: () => log.info('feishu_ws_reconnected'),
    onError: (error) => log.error({ error }, 'feishu_ws_failed'),
  })
  await ws.start({ eventDispatcher: dispatcher })
  const api = createMessageApi(client)
  server = await startJsonServer({
    baseUrl: feishu.gatewayUrl,
    async handler({ request, response, url, body }) {
      if (request.method === 'GET' && url.pathname === '/health') {
        const health = feishuGatewayHealth(
          ws?.getConnectionStatus().state === 'connected',
          botIdentity.openId,
        )
        writeJson(response, health.status, health.body)
        return
      }
      if (request.method !== 'POST') {
        writeJson(response, 404, { ok: false, error: 'not found' })
        return
      }
      if (url.pathname === '/send') {
        const delivery = parseDeliveryRequest(body)
        const authorization = await authorizeFeishuDelivery({
          request: delivery,
          appId: feishu.appId,
          groupIds: feishu.groupIds,
          isObservedConversation,
          isMessageInConversation,
        })
        if (authorization) return { status: 'failed', code: 'target_not_allowed', error: authorization }
        return sendFeishuDelivery(api, delivery)
      }
      if (url.pathname === '/conversations') {
        return { conversations: await listConversations(client) }
      }
      writeJson(response, 404, { ok: false, error: 'not found' })
    },
  })
  log.info({ url: feishu.gatewayUrl, appId: feishu.appId }, 'feishu_gateway_started')
}

function createDispatcher(
  client: Client,
  botIdentity: BotIdentity,
  workQueue: ConversationWorkQueue,
): EventDispatcher {
  return new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
    'im.message.receive_v1': (event) => {
      const chatId = event.message.chat_id
      workQueue.schedule(chatId, async () => {
        try {
          const message = await normalize(event as RawMessageEvent, {
            botIdentity,
            stripBotMentions: true,
            includeRaw: true,
          })
          if (message.senderId === botIdentity.openId) return
          if (message.chatType === 'group' && !feishu!.groupIds.includes(message.chatId)) return
          const classification = classifyFeishuReceive({
            eventId: event.event_id,
            messageId: event.message.message_id,
            createTime: event.message.create_time,
            updateTime: event.message.update_time,
          })
          await persistFeishuIncomingMessage({
            accountId: feishu!.appId,
            eventId: classification.eventExternalId,
            eventKind: classification.eventKind,
            message,
          }, {
            downloadResource: (messageId, fileKey, type) => downloadMessageResource(
              client,
              messageId,
              fileKey,
              type,
            ),
          })
        } catch (error) {
          await recordIngressFailure({ platform: 'feishu', kind: 'message', error, context: { chatId, messageId: event.message.message_id } }).catch(() => undefined)
          log.error({ error, chatId, messageId: event.message.message_id }, 'feishu_message_ingress_failed')
        }
      })
    },
    'im.message.recalled_v1': (event) => {
      if (!event.message_id || !event.chat_id) return
      workQueue.schedule(event.chat_id, async () => {
        try {
          const recallTime = secondsFromFeishuTime(event.recall_time ?? event.create_time)
          const result = await withTransientRetry(() => persistMessageRecall({
            platform: 'feishu',
            accountId: feishu!.appId,
            eventExternalId: event.event_id ?? `recall:${event.message_id}:${recallTime}`,
            messageExternalId: event.message_id!,
            conversationExternalId: event.chat_id!,
            recalledAt: recallTime,
            rawContent: event,
          }), { onRetry: ({ error, attempt, delayMs }) => log.warn({ error, attempt, delayMs, chatId: event.chat_id }, 'feishu_ingress_persist_retry') })
          if (!result) log.warn({ chatId: event.chat_id, messageId: event.message_id }, 'feishu_recall_original_missing')
        } catch (error) {
          await recordIngressFailure({ platform: 'feishu', kind: 'recall', error, context: { chatId: event.chat_id!, messageId: event.message_id! } }).catch(() => undefined)
          log.error({ error, chatId: event.chat_id, messageId: event.message_id }, 'feishu_recall_ingress_failed')
        }
      })
    },
  })
}

function createMessageApi(client: Client): FeishuMessageApi {
  return {
    async uploadImage(bytes) {
      const response = await client.im.v1.image.create({ data: { image_type: 'message', image: bytes } })
      if (!response?.image_key) throw new Error('Feishu image upload returned no image_key')
      return response.image_key
    },
    async create(input) {
      const response = await client.im.v1.message.create({
        params: { receive_id_type: input.receiveIdType },
        data: {
          receive_id: input.receiveId,
          msg_type: input.msgType,
          content: input.content,
          uuid: input.uuid,
        },
      })
      return { code: response.code, message: response.msg, messageId: response.data?.message_id }
    },
    async reply(input) {
      const response = await client.im.v1.message.reply({
        path: { message_id: input.messageId },
        data: { msg_type: input.msgType, content: input.content, uuid: input.uuid },
      })
      return { code: response.code, message: response.msg, messageId: response.data?.message_id }
    },
  }
}

async function fetchBotIdentity(client: Client): Promise<BotIdentity> {
  const response = await client.request<{
    code?: number
    msg?: string
    bot?: { open_id?: string; app_name?: string }
    data?: { bot?: { open_id?: string; app_name?: string } }
  }>({ method: 'GET', url: '/open-apis/bot/v3/info/' })
  const bot = response.bot ?? response.data?.bot
  if (response.code != null && response.code !== 0) {
    throw new Error(`Feishu bot info failed (${response.code}): ${response.msg ?? 'unknown error'}`)
  }
  if (!bot?.open_id) throw new Error('Feishu bot info returned no open_id')
  return { openId: bot.open_id, name: bot.app_name ?? feishu!.appId }
}

async function downloadMessageResource(
  client: Client,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
): Promise<Buffer> {
  const response = await client.im.v1.messageResource.get({
    params: { type },
    path: { message_id: messageId, file_key: fileKey },
  })
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.getReadableStream()) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.byteLength
    chunks.push(bytes)
    if (size > FEISHU_MEDIA_MAX_BYTES) break
  }
  return Buffer.concat(chunks)
}

async function listConversations(client: Client) {
  const observed = await findObservedConversations({ platform: 'feishu', accountId: feishu!.appId })
  const byId = new Map(observed.map((item) => [item.target.externalId, item]))
  for (const chatId of feishu!.groupIds) {
    let displayName = chatId
    try {
      const response = await client.im.v1.chat.get({ path: { chat_id: chatId } })
      displayName = response.data?.name || chatId
    } catch (error) {
      log.warn({ error, chatId }, 'feishu_chat_name_lookup_failed')
    }
    byId.set(chatId, {
      target: { platform: 'feishu', accountId: feishu!.appId, kind: 'group', externalId: chatId },
      displayName,
    })
  }
  return [...byId.values()].filter((item) => (
    item.target.kind === 'private' || feishu!.groupIds.includes(item.target.externalId)
  ))
}

function parseDeliveryRequest(value: unknown): DeliveryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
  const input = value as Record<string, unknown>
  const target = input.target
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('target is required')
  const candidate = target as Record<string, unknown>
  if (
    candidate.platform !== 'feishu'
    || typeof candidate.accountId !== 'string'
    || (candidate.kind !== 'group' && candidate.kind !== 'private')
    || typeof candidate.externalId !== 'string'
    || typeof input.actionId !== 'string'
  ) throw new Error('invalid Feishu delivery request')
  return {
    actionId: input.actionId,
    target: {
      platform: 'feishu', accountId: candidate.accountId,
      kind: candidate.kind, externalId: candidate.externalId,
    },
    ...(typeof input.text === 'string' ? { text: input.text } : {}),
    ...(typeof input.imageBase64 === 'string' ? { imageBytes: Buffer.from(input.imageBase64, 'base64') } : {}),
    ...(typeof input.replyToExternalId === 'string' ? { replyToExternalId: input.replyToExternalId } : {}),
    ...(typeof input.mentionExternalId === 'string' ? { mentionExternalId: input.mentionExternalId } : {}),
  }
}

function secondsFromFeishuTime(value: string | undefined): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.floor(Date.now() / 1000)
  return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric)
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'feishu_gateway_shutdown_requested')
  ws?.close()
  if (server) await closeServer(server).catch((error) => log.warn({ error }, 'feishu_gateway_server_close_failed'))
  await queue?.drain()
  await prisma.$disconnect()
}

process.once('SIGINT', () => void shutdown('SIGINT').finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown('SIGTERM').finally(() => process.exit(0)))

void main().catch(async (error) => {
  log.fatal({ error }, 'feishu_gateway_start_failed')
  await shutdown('startup_failure')
  process.exitCode = 1
})
