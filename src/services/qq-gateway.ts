import type { Server } from 'node:http'
import { prisma } from '../database/client.js'
import { connectNapcat, registerNapcatHandlers } from '../bot/core.js'
import { disconnectNapcatForShutdown, napcat } from '../bot/napcat.js'
import { config } from '../config/index.js'
import { createLogger } from '../logger.js'
import { sendSegmentsRaw } from '../messaging/napcat-sender.js'
import { closeServer, startJsonServer, writeJson } from './http.js'
import { qqGatewayHealth } from './qq-gateway-health.js'

const log = createLogger('QQ_GATEWAY')
let server: Server | null = null
let connected = false
let backfillCompleted = false
let shuttingDown = false

async function main(): Promise<void> {
  await prisma.$connect()
  const lifecycle = registerNapcatHandlers()
  await connectNapcat()
  connected = true

  server = await startJsonServer({
    baseUrl: config.services.qqGatewayUrl,
    async handler({ request, response, url, body }) {
      if (request.method === 'GET' && url.pathname === '/health') {
        const health = qqGatewayHealth(connected, backfillCompleted)
        writeJson(response, health.status, health.body)
        return
      }
      if (!backfillCompleted) {
        writeJson(response, 503, { ok: false, error: 'initial backfill is still in progress' })
        return
      }
      if (request.method !== 'POST') {
        writeJson(response, 404, { ok: false, error: 'not found' })
        return
      }

      const input = asObject(body)
      if (url.pathname === '/send') {
        const target = input.target
        const segments = input.segments
        if (!isSendTarget(target) || !Array.isArray(segments)) throw new Error('invalid send request')
        return sendSegmentsRaw(target, segments as never)
      }
      if (url.pathname === '/friends') {
        const friends = await napcat.get_friend_list()
        return {
          friends: friends.map((friend) => ({
            userId: friend.user_id,
            nickname: friend.nickname,
            remark: friend.remark,
          })),
        }
      }
      if (url.pathname === '/groups') {
        const groups = await napcat.get_group_list()
        return {
          groups: groups.map((group) => ({
            groupId: group.group_id,
            groupName: group.group_name,
            groupRemark: group.group_remark,
            memberCount: group.member_count,
            maxMemberCount: group.max_member_count,
          })),
        }
      }
      if (url.pathname === '/group-info') {
        const groupId = positiveInteger(input.groupId, 'groupId')
        const group = await napcat.get_group_info({ group_id: groupId })
        return { groupName: group.group_name }
      }
      if (url.pathname === '/group-shut-list') {
        const groupId = positiveInteger(input.groupId, 'groupId')
        return { entries: await napcat.get_group_shut_list({ group_id: groupId }) }
      }

      writeJson(response, 404, { ok: false, error: 'not found' })
    },
  })
  log.info({ url: config.services.qqGatewayUrl }, 'qq_gateway_listening')

  await lifecycle.initialBackfillDone
  backfillCompleted = true
  log.info('qq_gateway_initial_backfill_completed')
  log.info({ url: config.services.qqGatewayUrl }, 'qq_gateway_started')
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ signal }, 'qq_gateway_shutdown_requested')
  if (connected) disconnectNapcatForShutdown()
  connected = false
  if (server) await closeServer(server).catch((error) => log.warn({ error }, 'qq_gateway_server_close_failed'))
  await prisma.$disconnect()
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return value
}

function isSendTarget(value: unknown): value is
  | { type: 'group'; groupId: number }
  | { type: 'private'; userId: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  return target.type === 'group'
    ? typeof target.groupId === 'number' && Number.isSafeInteger(target.groupId)
    : target.type === 'private'
      && typeof target.userId === 'number'
      && Number.isSafeInteger(target.userId)
}

process.once('SIGINT', () => void shutdown('SIGINT').finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown('SIGTERM').finally(() => process.exit(0)))

void main().catch(async (error) => {
  log.fatal({ error }, 'qq_gateway_start_failed')
  await shutdown('startup_failure')
  process.exitCode = 1
})
