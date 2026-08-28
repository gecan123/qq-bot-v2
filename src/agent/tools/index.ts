import { createDeferredToolExecutor, type DeferredToolCapability, type Tool } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import type { BackgroundTaskRegistry } from '../background-task-registry.js'
import type { GroupPolicy } from '../../config/group-policies.js'
import type { TargetMetadataMaps } from '../resolve-target-meta.js'
import { createRestTool } from './rest.js'
import { createSendMessageTool } from './send-message.js'
import { maybeCreateWebSearchTool } from './web-search.js'
import { createGenerateImageTool } from './generate-image.js'
import { createBackgroundTaskTool } from './background-task.js'
import { createMemoryTool } from './memory.js'
import { skillTool } from './skill.js'
import { collectStickerTool } from './collect-sticker.js'
import { createWorkspaceBashTool } from './workspace-bash.js'
import { maybeCreateBrowserTool } from './browser.js'
import { maybeCreateOpenbbCliTool } from './openbb-cli.js'
import { maybeCreateWebsiteTool } from './website.js'
import { createFetchContentTool, fetchContentScopeAccepts } from './fetch-content.js'
import { createInboxTool } from './inbox.js'
import { createChatStyleTool } from './chat-style.js'
import { createNotebookTool } from './notebook.js'
import { workspaceFileTool } from './workspace-file.js'
import { createReadFileTool } from './read-file.js'
import { createInspectMediaTool } from './inspect-media.js'
import { maybeCreateCryptoPaperTool } from './crypto-paper.js'
import { maybeCreateTradingAgentTool } from './trading-agent.js'
import type { ConversationSendPolicy } from '../conversation-send-policy.js'
import type { MessageDelivery } from '../../messaging/message-delivery.js'
import type { SendTargetPolicy } from '../send-target-policy.js'
import { createMessageDelivery } from '../../messaging/message-delivery.js'
import { createQqDeliveryAdapter } from '../../messaging/qq-delivery-adapter.js'
import { createAgentTaskScheduler, type TaskScheduler } from '../task-scheduler.js'
import { createQqDirectoryTool, type QqDirectoryDeps } from './qq-directory.js'
import { createScheduleTool } from './schedule.js'
import type { ScheduleRuntime } from '../schedule-runtime.js'
import type { MemoryMaintenanceRuntime } from '../memory-maintenance.js'
import type { WorkspaceStateCoordinator } from '../workspace-state-coordinator.js'
import type { LoadMemorySourceEvidence } from '../memory-evidence.js'
import { createConversationTool, type ConversationController } from './conversation.js'
import type { ConversationSummary } from './conversation.js'
import type { ParticipantRef } from '../../chat/conversation.js'
import { applyBotToolPolicy } from './policies.js'
import type { InboxReadCursors } from '../inbox-read-cursors.js'
import { maybeCreateMoomooSkillTool } from './moomoo-skill.js'
import type { GroupMuteInspector } from '../../messaging/group-mute-inspector.js'
import type { LlmClient } from '../llm-client.js'
import { createPsychologistTool } from './psychologist.js'

export interface BotToolDeps {
  llm: LlmClient
  sender: MessageSender
  targetPolicy: ConversationSendPolicy | SendTargetPolicy
  delivery?: MessageDelivery
  conversations: ConversationController
  groupMuteInspector?: GroupMuteInspector
  taskRegistry: BackgroundTaskRegistry
  groupIds: readonly number[]
  selfNumber: number
  getInboxReadCursors?: () => Readonly<InboxReadCursors>
  metadata: TargetMetadataMaps
  groupPolicies: readonly GroupPolicy[]
  qqDirectory: QqDirectoryDeps
  optionalTools?: BotOptionalTools
  taskScheduler?: TaskScheduler
  scheduleRuntime: ScheduleRuntime
  memoryMaintenance?: MemoryMaintenanceRuntime
  workspaceDir?: string
  workspaceStateCoordinator?: WorkspaceStateCoordinator
  loadMemorySourceEvidence?: LoadMemorySourceEvidence
  ownerId?: string
  ownerIdentities?: readonly ParticipantRef[]
  additionalConversations?: () => Promise<readonly ConversationSummary[]>
  selfExternalIds?: Partial<Record<'qq' | 'feishu', string>>
}

export interface BotOptionalTools {
  browser?: Tool | null
  openbb?: Tool | null
  tradingAgent?: Tool | null
  website?: Tool | null
  webSearch?: Tool | null
  cryptoPaper?: Tool | null
  moomoo?: Tool | null
}

export interface BotToolManifest {
  alwaysOnTools: Tool[]
  capabilities: DeferredToolCapability[]
}

export function buildBotToolManifest(deps: BotToolDeps): BotToolManifest {
  const taskScheduler = deps.taskScheduler ?? createAgentTaskScheduler()
  const externalResearchFetchContent = createFetchContentTool({
    taskRegistry: deps.taskRegistry,
    taskScheduler,
    scope: 'external_research',
  })
  const mediaFetchContent = createFetchContentTool({
    taskRegistry: deps.taskRegistry,
    taskScheduler,
    scope: 'media_fetch',
  })
  const cryptoPaper = resolveOptionalTool(deps.optionalTools, 'cryptoPaper', maybeCreateCryptoPaperTool)
  const moomoo = resolveOptionalTool(deps.optionalTools, 'moomoo', maybeCreateMoomooSkillTool)
  const tradingAgent = resolveOptionalTool(
    deps.optionalTools,
    'tradingAgent',
    () => maybeCreateTradingAgentTool({ taskRegistry: deps.taskRegistry }) ?? null,
  )
  const qqDirectory = createQqDirectoryTool(deps.qqDirectory)
  const conversation = createConversationTool(deps.conversations)
  const sendMessage = createSendMessageTool({
    delivery: deps.delivery ?? createMessageDelivery([createQqDeliveryAdapter(deps.sender)]),
    targetPolicy: deps.targetPolicy as ConversationSendPolicy,
    conversations: deps.conversations,
    ...(deps.groupMuteInspector ? { groupMuteInspector: deps.groupMuteInspector } : {}),
  })
  const backgroundTask = createBackgroundTaskTool({ taskRegistry: deps.taskRegistry })
  const inbox = createInboxTool({
    loadAllowedConversations: async () => [
      ...deps.groupIds.map((groupId) => ({
        platform: 'qq' as const,
        accountId: String(deps.selfNumber),
        kind: 'group' as const,
        externalId: String(groupId),
      })),
      ...(await deps.qqDirectory.loadFriends()).map((friend) => ({
        platform: 'qq' as const,
        accountId: String(deps.selfNumber),
        kind: 'private' as const,
        externalId: String(friend.userId),
      })),
      ...(await deps.additionalConversations?.() ?? []).map((item) => item.target),
    ],
    selfExternalIds: { qq: String(deps.selfNumber), ...deps.selfExternalIds },
    ...(deps.getInboxReadCursors ? { getReadCursors: deps.getInboxReadCursors } : {}),
  })
  const chatStyle = createChatStyleTool({
    groupIds: deps.groupIds,
    metadata: deps.metadata,
    groupPolicies: deps.groupPolicies,
  })
  const psychologist = createPsychologistTool({ llm: deps.llm })
  const rest = createRestTool()
  const schedule = createScheduleTool(deps.scheduleRuntime)
  const notebook = createNotebookTool({
    rootDir: deps.workspaceDir,
    workspaceStateCoordinator: deps.workspaceStateCoordinator,
  })
  const collectSticker = collectStickerTool
  const workspaceBash = createWorkspaceBashTool({ workspaceDir: deps.workspaceDir })
  const tools: Tool[] = [
    rest,
    qqDirectory,
    backgroundTask,
    skillTool,
    psychologist,
    createMemoryTool({
      workspaceDir: deps.workspaceDir,
      maintenance: deps.memoryMaintenance,
      workspaceStateCoordinator: deps.workspaceStateCoordinator,
      loadSourceEvidence: deps.loadMemorySourceEvidence,
      ownerId: deps.ownerId,
      ownerIdentities: deps.ownerIdentities,
    }),
    inbox,
    chatStyle,
  ]
  const capabilities: DeferredToolCapability[] = []

  capabilities.push({
    name: 'chat',
    description: 'QQ / 飞书会话导航与发送；先打开当前会话，再通过 invoke 发送文本、图片或 QQ 音乐.',
    tools: [conversation, sendMessage],
  })

  capabilities.push(
    {
      name: 'short_term_scheduling',
      description: '未来三天内的一次性重新唤醒；scheduled wake 只是重新评估信号，不用于等回复或机械轮询.',
      tools: [schedule],
    },
    {
      name: 'notebook_management',
      description: '跨天维护研究、阅读、市场和项目过程；稳定结论写 memory，定时唤醒用 schedule.',
      tools: [notebook],
    },
    {
      name: 'sticker_management',
      description: '收藏、搜索、随机选择或移除 QQ 表情包候选.',
      tools: [collectSticker],
    },
  )

  const browser = resolveOptionalTool(deps.optionalTools, 'browser', maybeCreateBrowserTool)
  if (browser) {
    capabilities.push({
      name: 'browser',
      description: '真实浏览器阅读: 复用登录态打开网页、读取正文、观察页面、滚动、安全导航、截图和请求主人协助；controller 默认只读.',
      tools: [browser],
    })
  }

  const openbb = resolveOptionalTool(deps.optionalTools, 'openbb', maybeCreateOpenbbCliTool)
  const financeTools = [openbb, moomoo, cryptoPaper, tradingAgent]
    .filter((tool): tool is Tool => tool != null)
  if (financeTools.length > 0) {
    capabilities.push({
      name: 'finance',
      description: [
        '金融数据、受限模拟交易与深度研究：OpenBB、Moomoo、本地 Crypto 纸面账户，以及用于跨来源证据、策略规则和历史回测的 trading_agent。',
        ...(cryptoPaper ? ['Luna 可在长期授权边界内自主经营 BTC/ETH/SOL 本地模拟仓；'] : []),
        '普通证券模拟订单仍需用户逐次授权。具体工具以 describe 结果为准.',
      ].join(' '),
      tools: financeTools,
    })
  }

  const website = resolveOptionalTool(deps.optionalTools, 'website', maybeCreateWebsiteTool)
  if (website) {
    capabilities.push({
      name: 'website',
      description: '维护 Luna 自己的长期创作空间“Luna 的自留地”: 文章写入 src/content/blog 并先读现有模板；也可维护 src 下的页面、组件、布局、样式和素材以及 public 静态资源。已有值得打磨的作品时优先 read + revision 修改；重要作品可先 draft、向一个相关对象问具体反馈，再发布或更新。publish 只代表构建、commit 和 push 成功，确认正式页面可见后才能称为上线。不要为制造进展批量换题、机械改动或发布空内容.',
      tools: [website],
    })
  }

  const webSearch = resolveOptionalTool(deps.optionalTools, 'webSearch', maybeCreateWebSearchTool)
  capabilities.push({
    name: 'external_research',
    description: '外部内容与研究: 搜索互联网、抓普通网页和读取 Reddit.',
    tools: webSearch ? [webSearch, externalResearchFetchContent] : [externalResearchFetchContent],
    acceptsToolCall: (toolName, args) => (
      toolName !== 'fetch_content' || fetchContentScopeAccepts('external_research', args)
    ),
  })

  capabilities.push(
    {
      name: 'workspace_management',
      description: '普通私有工作文件：结构化读写，以及受限的只读 pwd/ls/rg/cat/head/tail/wc 命令；不提供通用 shell.',
      tools: [workspaceFileTool, workspaceBash],
    },
    {
      name: 'document_reading',
      description: '读取 QQ 或飞书收到的文件: 从 inbox 的 file mediaId 提取纯文本、PDF、Office 或 OpenDocument 内容并分页查看.',
      tools: [createReadFileTool()],
    },
    {
      name: 'media_inspection',
      description: '主动查看已有图片: 补跑入站图片描述并把真实预览作为 image block 放进当前上下文.',
      tools: [createInspectMediaTool({ taskScheduler })],
    },
    {
      name: 'media_generation',
      description: 'AI 图片生成和基于已有图片的编辑.',
      tools: [createGenerateImageTool({ taskRegistry: deps.taskRegistry })],
    },
    {
      name: 'media_fetch',
      description: '下载图片 URL 或 QQ 头像, 生成可发送、编辑或收藏的 image handle.',
      tools: [mediaFetchContent],
      acceptsToolCall: (toolName, args) => (
        toolName !== 'fetch_content' || fetchContentScopeAccepts('media_fetch', args)
      ),
    },
  )

  return {
    alwaysOnTools: tools.map(applyBotToolPolicy),
    capabilities: capabilities.map((capability) => ({
      ...capability,
      tools: capability.tools.map(applyBotToolPolicy),
    })),
  }
}

function resolveOptionalTool(
  overrides: BotOptionalTools | undefined,
  name: keyof BotOptionalTools,
  factory: () => Tool | null,
): Tool | null {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
    return overrides[name] ?? null
  }
  return factory()
}

export function buildBotTools(deps: BotToolDeps): Tool[] {
  const manifest = buildBotToolManifest(deps)
  return createDeferredToolExecutor(manifest).list()
}
