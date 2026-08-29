import { NCWebsocket, type NodeSegment } from 'node-napcat-ts'
import { config } from '../src/config/index.js'
import { QqGatewayClient } from '../src/services/qq-gateway-client.js'

const CONFIRM_FLAG = '--confirm-send'
const REQUEST_TIMEOUT_MS = 15_000

type TestResult = {
  transport: 'qq_gateway' | 'direct_napcat'
  providerMessageId: number
  napcatVersion?: string
}

function buildTestNodes(nickname: string): NodeSegment[] {
  const sentAt = new Date().toISOString()
  const pages = [
    [
      'QQ 折叠消息测试（1/2）',
      '',
      '如果你看到的是一条“聊天记录”卡片，而不是正文直接铺在私聊窗口里，说明 node-only 消息已经被 NapCat 转换成合并转发。',
    ].join('\n'),
    [
      'QQ 折叠消息测试（2/2）',
      '',
      '请点开卡片，确认这两页正文可以正常展开。这个脚本只允许发送给配置中的主人，不接受任意 QQ 号。',
      '',
      `测试时间：${sentAt}`,
    ].join('\n'),
  ]

  return pages.map((text, index) => ({
    type: 'node',
    data: {
      user_id: String(config.selfNumber),
      nickname: `${nickname} · ${index + 1}/${pages.length}`,
      content: [{ type: 'text', data: { text } }],
    },
  }))
}

async function withTimeout<T>(label: string, operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS}ms`)), REQUEST_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function probeGateway(): Promise<'ready' | 'absent'> {
  try {
    const response = await fetch(new URL('/health', config.services.qqGatewayUrl), {
      signal: AbortSignal.timeout(2_000),
    })
    const body = await response.json() as { ok?: boolean; connected?: boolean; backfillCompleted?: boolean }
    if (response.ok && body.ok && body.connected && body.backfillCompleted) return 'ready'
    throw new Error(`QQ Gateway is reachable but not ready: HTTP ${response.status}`)
  } catch (error) {
    if (error instanceof TypeError) return 'absent'
    throw error
  }
}

async function sendThroughGateway(ownerQq: number, nodes: NodeSegment[]): Promise<TestResult> {
  const gateway = new QqGatewayClient(config.services.qqGatewayUrl, REQUEST_TIMEOUT_MS)
  const friends = await gateway.friends()
  if (!friends.some((friend) => friend.userId === ownerQq)) {
    throw new Error('configured owner is not present in the QQ Gateway friend list')
  }
  const result = await gateway.send(
    { type: 'private', userId: ownerQq },
    nodes as never,
  )
  if (!result.success || result.providerMessageId == null) {
    throw new Error('QQ Gateway did not confirm the folded test message')
  }
  return {
    transport: 'qq_gateway',
    providerMessageId: result.providerMessageId,
  }
}

async function sendDirectly(ownerQq: number): Promise<TestResult> {
  const client = new NCWebsocket({
    baseUrl: config.napcat.wsUrl,
    accessToken: config.napcat.accessToken,
    throwPromise: true,
    reconnection: { enable: false, attempts: 1, delay: 0 },
  })

  try {
    await withTimeout('NapCat connection', client.connect())
    const [login, friends, version] = await withTimeout('NapCat identity check', Promise.all([
      client.get_login_info(),
      client.get_friend_list(),
      client.get_version_info(),
    ]))
    if (login.user_id !== config.selfNumber) {
      throw new Error('NapCat login account does not match SELF_NUMBER')
    }
    if (!friends.some((friend) => friend.user_id === ownerQq)) {
      throw new Error('configured owner is not present in the NapCat friend list')
    }

    const result = await withTimeout('folded private message send', client.send_private_msg({
      user_id: ownerQq,
      message: buildTestNodes(login.nickname),
    }))
    return {
      transport: 'direct_napcat',
      providerMessageId: result.message_id,
      napcatVersion: version.app_version,
    }
  } finally {
    client.disconnect()
  }
}

async function main(): Promise<void> {
  const unexpectedArgs = process.argv.slice(2).filter((arg) => arg !== CONFIRM_FLAG)
  if (unexpectedArgs.length > 0) {
    throw new Error(`unsupported arguments: ${unexpectedArgs.join(', ')}`)
  }
  if (!config.owner) throw new Error('BOT_OWNER_QQ and BOT_OWNER_NAME must be configured')

  if (!process.argv.includes(CONFIRM_FLAG)) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      dryRun: true,
      target: 'configured_owner',
      nodeCount: buildTestNodes('Luna').length,
      run: `pnpm exec tsx scripts/send-owner-folded-message-test.ts ${CONFIRM_FLAG}`,
    }, null, 2)}\n`)
    return
  }

  const gateway = await probeGateway()
  const result = gateway === 'ready'
    ? await sendThroughGateway(config.owner.qq, buildTestNodes('Luna'))
    : await sendDirectly(config.owner.qq)

  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'sent',
    target: 'configured_owner',
    nodeCount: 2,
    ...result,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
