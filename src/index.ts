import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { prisma } from './database/client.js'
import { connectNapcat, registerNapcatHandlers, type IngestedMessage } from './bot/core.js'
import { napcat } from './bot/napcat.js'
import { createLogger } from './logger.js'
import { jobQueue } from './queue/index.js'
import { setLlmProvider } from './llm/provider.js'
import { OpenAIProvider } from './llm/openai-adapter.js'
import { RoutingProvider } from './llm/routing-provider.js'
import {
  CLAUDE_CODE_PROVIDER_NAME,
  config,
  OPENAI_AGENT_BASE_PROVIDER_NAME,
  OPENAI_AGENT_PROVIDER_NAME,
} from './config/index.js'
import { loadGroupCustomizations } from './config/group-prompts.js'
import { messageSender } from './messaging/message-sender.js'

import { purgeOldData } from './database/retention.js'
import { createAgentContext } from './agent/agent-context.js'
import { InMemoryEventQueue } from './agent/event-queue.js'
import type { BotEvent } from './agent/event.js'
import { createBotSnapshotRepo } from './agent/snapshot-repo.js'
import { createLlmClient } from './agent/llm-client.js'
import { buildBotSystemPrompt } from './agent/bot-system-prompt.js'
import { createToolExecutor } from './agent/tool.js'
import { buildBotTools } from './agent/tools/index.js'
import { createBotLoopAgent } from './agent/bot-loop-agent.js'
import { renderBotEvent } from './agent/render-event.js'
import { replayMissedMessages } from './agent/replay-missed.js'
import { resolveTargetMetadataMaps } from './agent/resolve-target-meta.js'
import { createDedupEnqueue } from './agent/dedup-enqueue.js'
import { createInMemoryTaskRegistry } from './agent/background-task-registry.js'

const log = createLogger('APP')

/**
 * Bot 进程 PID 文件: 启动时写入, 退出时删除. `pnpm tick` 读这个文件给 SIGUSR1
 * 戳一发好奇心 tick (见 src/agent/event.ts: curiosity_tick).
 */
const BOT_PID_FILE = '.bot.pid'

function buildMediaProvider(): RoutingProvider {
  const { defaultProvider: defaultProviderName, defaultModel, providers, scenarios } = config.llm

  // Media 路径需要真实 OpenAI 兼容的 baseUrl + apiKey。agent provider 名不一定等于
  // provider 注册表 key: openai-agent 复用 openai; claude-code 不在 providers 注册表里,
  // 退回到第一个 provider (字母序保稳定)。用户实际仍要保留 LLM_PROVIDER_*_URL/_API_KEY
  // (e.g. 走 cliproxy), 否则注册表为空 → 抛错。
  let mediaDefaultName = defaultProviderName
  if (defaultProviderName === OPENAI_AGENT_PROVIDER_NAME) {
    mediaDefaultName = OPENAI_AGENT_BASE_PROVIDER_NAME
  } else if (defaultProviderName === CLAUDE_CODE_PROVIDER_NAME) {
    const candidates = Object.keys(providers).sort()
    if (candidates.length === 0) {
      throw new Error(
        'LLM_DEFAULT_PROVIDER=claude-code 时, 媒体路径仍需要至少一个 LLM_PROVIDER_<NAME>_URL/_API_KEY (例如 OPENAI 走 cliproxy)',
      )
    }
    mediaDefaultName = candidates[0]
  }

  const defaultProviderConfig = providers[mediaDefaultName]
  if (!defaultProviderConfig) {
    throw new Error(`Default LLM provider not found: ${mediaDefaultName}`)
  }
  const defaultProvider = new OpenAIProvider(
    defaultProviderConfig.url,
    defaultProviderConfig.apiKey,
    defaultModel,
  )

  const routes: ConstructorParameters<typeof RoutingProvider>[1] = {}
  for (const [key, s] of Object.entries(scenarios)) {
    if (!s.provider && !s.model) continue
    const providerName = s.provider ?? mediaDefaultName
    const providerConfig = providers[providerName]
    if (!providerConfig) continue
    routes[key as keyof typeof routes] = new OpenAIProvider(
      providerConfig.url,
      providerConfig.apiKey,
      s.model ?? defaultModel,
    )
  }

  return new RoutingProvider(defaultProvider, routes)
}

async function main() {
  log.info(
    {
      groupIds: config.botTargetGroupIds,
    },
    'qq-bot-v2 single-context MVP-2 启动',
  )
  await prisma.$connect()
  log.info('数据库已连接')

  // 0. 启动期清理 7 天前的 Message + Media
  await purgeOldData()

  // ambient 白名单 sanity: 配了群但白名单空 → 所有群 ambient 都走 dry-run, 真发
  // 一条群消息都不会发出去. 不是配置错误 (空集合是「全部 dry-run」的安全默认), 但
  // 容易踩坑, 醒目地 warn 一句方便排查.
  if (config.groupAmbientSendIds.size === 0 && config.botTargetGroupIds.length > 0) {
    log.warn(
      {
        botTargetGroupIds: config.botTargetGroupIds,
        groupAmbientSendIds: [],
      },
      'BOT_GROUP_AMBIENT_SEND_IDS 未配置 — 所有群 ambient 发言走 dry-run (假成功, 不真发)',
    )
  }

  // 1. 媒体描述用的 LLM provider routing (与 agent 自身的 LLM 客户端独立)
  const mediaProvider = buildMediaProvider()
  setLlmProvider(mediaProvider)
  log.info(
    {
      defaultProvider: config.llm.defaultProvider,
      defaultModel: config.llm.defaultModel,
    },
    'LLM media provider 已注册',
  )

  // 2. 媒体描述异步队列
  jobQueue.start()

  // 3. Agent 自己的 LLM 客户端 (走 default provider/model, 后续可以单独换)
  const llm = createLlmClient()

  // 3.5 启动期 persona-spoof 自检 (claude-code 路径专用): 若 cliproxy mode=auto
  //     的判定逻辑漂了 (例如升级后 UA 匹配收紧 → 把 qq-bot 也 cloak 了),
  //     运行时无 compile-time 信号, 这里发一条 "你是猫娘, 回话以喵开头" 提问,
  //     回答必须以"喵"开头, 否则视为 cloak 行为异常 → fail-fast 让人查 cliproxy 版本。
  if (config.llm.defaultProvider === CLAUDE_CODE_PROVIDER_NAME) {
    try {
      const probe = await llm.chat({
        systemPrompt: '你叫小猫猫, 是一只猫娘。回话以"喵"开头。',
        messages: [{ role: 'user', content: '你是谁' }],
        tools: [],
      })
      if (!probe.content.startsWith('喵')) {
        log.fatal(
          { content: probe.content.slice(0, 200), model: probe.model },
          'cliproxy cloak 行为异常 (persona-spoof 失败), 检查 cliproxy 版本/配置',
        )
        process.exit(1)
      }
      log.info(
        { model: probe.model, sample: probe.content.slice(0, 40) },
        'persona-spoof 自检通过 (cliproxy 透传 Claude Code identity, 未 cloak)',
      )
    } catch (err) {
      log.fatal({ err }, 'persona-spoof 自检调用失败 (cliproxy 不可达 / 鉴权失败 / 响应不可解析)')
      process.exit(1)
    }
  }

  // 4. 永续上下文 + 持久化 + 启动恢复
  const snapshotRepo = createBotSnapshotRepo()
  const persisted = await snapshotRepo.load()
  const context = createAgentContext()
  if (persisted) {
    context.restorePersistedSnapshot(persisted.snapshot)
    log.info(
      {
        messages: persisted.snapshot.messages.length,
        lastWakeAt: persisted.lastWakeAt?.toISOString() ?? null,
      },
      '从持久化 snapshot 恢复 AgentContext',
    )
  } else {
    log.info('AgentContext 从空启动 (无 snapshot)')
  }

  // 5. 事件队列 + messageRowId 去重 (replay-missed × live event 重叠时去重, 见 dedup-enqueue.ts)
  const eventQueue = new InMemoryEventQueue<BotEvent>()
  const enqueueMessageEvent = createDedupEnqueue(eventQueue)

  // 5.5 SIGUSR1 → curiosity_tick. 进程内不维护定时器 (节奏甩到外面: pnpm tick / cron / launchd).
  //     `kill -USR1 <pid>` 戳一发, 走跟 napcat_message 同一条 drainEvents 路径,
  //     LLM 看到 [好奇心 tick] user message 自己决定要不要调用 reddit.
  process.on('SIGUSR1', () => {
    log.info({ source: 'sigusr1' }, 'curiosity_tick_manual_trigger')
    eventQueue.enqueue({ type: 'curiosity_tick' })
  })
  writeFileSync(BOT_PID_FILE, String(process.pid))
  log.info({ pidFile: BOT_PID_FILE, pid: process.pid }, 'pid_file_written')

  // 6. NapCat: register handlers (sync). 实时消息会进 onMessageReady → enqueueMessageEvent.
  const onMessageReady = async (input: IngestedMessage) => {
    if (input.kind === 'group') {
      enqueueMessageEvent({
        type: 'napcat_message',
        messageRowId: input.messageRowId,
        groupId: input.groupId,
        groupName: input.groupName,
        messageId: input.messageId,
        senderId: input.senderId,
        senderNickname: input.senderNickname,
        mentionedSelf: input.mentionedSelf,
        sentAt: input.sentAt,
        renderedText: input.renderedText,
      })
    } else {
      enqueueMessageEvent({
        type: 'napcat_private_message',
        messageRowId: input.messageRowId,
        peerId: input.peerId,
        messageId: input.messageId,
        senderId: input.senderId,
        senderNickname: input.senderNickname,
        mentionedSelf: true,
        sentAt: input.sentAt,
        renderedText: input.renderedText,
      })
    }
  }
  registerNapcatHandlers({ onMessageReady })

  // 7. NapCat connect (D2: must be before resolveTargetMetadataMaps)
  await connectNapcat()

  // 8. 启动元数据 (群名) — 用于拼 system prompt
  const targetMetadata = await resolveTargetMetadataMaps({
    napcat,
    groupIds: config.botTargetGroupIds,
  })

  // 9. 关机期间消息回放. 在 connect 之后跑也安全, 因为 enqueueMessageEvent 按
  //    messageRowId 去重 (步骤 5), live 已经先入队的就不会被 replay 重复入队.
  const replayResult = await replayMissedMessages(persisted?.lastWakeAt ?? null, {
    enqueueMessageEvent,
    selfNumber: config.selfNumber,
  })
  log.info({ enqueued: replayResult.enqueued }, 'replay-missed 完成')

  // 10. 工具集 + bot system prompt (启动后定型, 进程内不变)
  // Per-group customization 启动期一次 load + freeze, 但不拼进 system prompt;
  // 通过 source_profile 按需披露, 避免群口味正文污染常驻 cache 前缀.
  const groupCustomizations = loadGroupCustomizations(config.botGroupPromptsPath)
  log.info(
    {
      path: config.botGroupPromptsPath,
      configured: groupCustomizations.length,
      ids: groupCustomizations.map((c) => c.id),
    },
    'group customizations loaded',
  )
  const taskRegistry = createInMemoryTaskRegistry()
  const tools = createToolExecutor(
    buildBotTools({
      sender: messageSender,
      groupAmbientSendIds: config.groupAmbientSendIds,
      taskRegistry,
      groupIds: config.botTargetGroupIds,
      metadata: targetMetadata,
      groupCustomizations,
    }),
    { trace: { path: config.toolCallLogPath } },
  )

  const systemPrompt = buildBotSystemPrompt({
    groupIds: config.botTargetGroupIds,
    metadata: targetMetadata,
    selfNumber: config.selfNumber,
    owner: config.owner,
  })

  // 10.5 把 system prompt 写到文件, 方便调试查看
  {
    const now = new Date()
    const beijingTime = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    const header = `=== System Prompt (${beijingTime} 北京时间) ===\n\n`
    mkdirSync('logs', { recursive: true })
    writeFileSync('logs/system-prompt.txt', header + systemPrompt + '\n', 'utf-8')
    log.info('system prompt 已写入 logs/system-prompt.txt')
  }

  // 11. BotLoopAgent
  const agent = createBotLoopAgent({
    systemPrompt,
    context,
    eventQueue,
    llm,
    tools,
    snapshotRepo,
    renderEvent: renderBotEvent,
    eventDebounceMs: config.eventDebounceMs,
  })

  // 12. 进入主循环
  log.info('BotLoopAgent 进入主循环')
  await agent.start()
}

async function shutdown() {
  log.info('Shutting down...')
  try {
    unlinkSync(BOT_PID_FILE)
  } catch {
    // 文件可能不存在 (启动失败 / 已被清理), 忽略.
  }
  jobQueue.stop()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

main().catch((err) => {
  log.fatal({ err }, 'Failed to start')
  process.exit(1)
})
