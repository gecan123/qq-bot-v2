import type { Tool, ToolPolicy, ToolPolicyDecision } from '../tool.js'

const PARALLEL_READ: ToolPolicyDecision = Object.freeze({
  sideEffect: false,
  concurrency: 'parallel',
})
const EXCLUSIVE_READ: ToolPolicyDecision = Object.freeze({
  sideEffect: false,
  concurrency: 'exclusive',
})
const EXCLUSIVE_SIDE_EFFECT: ToolPolicyDecision = Object.freeze({
  sideEffect: true,
  concurrency: 'exclusive',
})

function fixed(decision: ToolPolicyDecision): ToolPolicy {
  return () => decision
}

function byAction(input: {
  parallel?: readonly string[]
  exclusive?: readonly string[]
  sideEffect?: readonly string[]
}): ToolPolicy {
  const parallel = new Set(input.parallel ?? [])
  const exclusive = new Set(input.exclusive ?? [])
  const sideEffect = new Set(input.sideEffect ?? [])
  return (args) => {
    const action = typeof args.action === 'string' ? args.action : ''
    if (parallel.has(action)) return PARALLEL_READ
    if (exclusive.has(action)) return EXCLUSIVE_READ
    if (sideEffect.has(action)) return EXCLUSIVE_SIDE_EFFECT
    return EXCLUSIVE_SIDE_EFFECT
  }
}

/**
 * Bot 工具的调度与审计单一事实源。
 *
 * 未知 name/action 一律 fail closed；新增工具必须在这里声明策略，否则 manifest
 * 构造直接失败，避免并发白名单和副作用日志各自漂移。
 */
export const BOT_TOOL_POLICIES: Readonly<Record<string, ToolPolicy>> = Object.freeze({
  pause: fixed(EXCLUSIVE_READ),
  qq_directory: fixed(PARALLEL_READ),
  background_task: byAction({ parallel: ['list', 'get'] }),
  schedule: byAction({ parallel: ['list', 'get_occurrence'], sideEffect: ['create', 'cancel'] }),
  approval: byAction({ parallel: ['list', 'status'], sideEffect: ['approve', 'cancel'] }),
  goal: byAction({
    parallel: ['get'],
    sideEffect: ['create_self', 'complete', 'report_blocker', 'abandon_self'],
  }),
  skill: fixed(PARALLEL_READ),
  memory: byAction({
    parallel: ['search', 'recall', 'review', 'read', 'list'],
    sideEffect: [
      'write',
      'delete',
      'update_entry',
      'delete_entry',
      'promote_entry',
      'mark_disputed',
      'supersede_entry',
      'compact',
    ],
  }),
  inbox: fixed(PARALLEL_READ),
  collect_sticker: byAction({
    parallel: ['list', 'search', 'random'],
    sideEffect: ['collect', 'remove'],
  }),
  chat_style: fixed(PARALLEL_READ),
  notebook: byAction({
    parallel: ['list', 'search', 'read'],
    sideEffect: ['write', 'update', 'delete', 'compact'],
  }),
  life_journal: byAction({
    parallel: ['read_recent', 'read_day', 'read_entry', 'read_agenda'],
    sideEffect: ['write', 'update', 'delete', 'compact', 'write_agenda'],
  }),
  crypto_paper: byAction({
    exclusive: ['account', 'portfolio', 'orders'],
    sideEffect: ['buy', 'sell', 'reset'],
  }),
  workspace_bash: fixed(PARALLEL_READ),
  db: fixed(PARALLEL_READ),
  metrics: fixed(PARALLEL_READ),
  qq_conversation: byAction({
    exclusive: ['list', 'current'],
    sideEffect: ['open', 'close'],
  }),
  send_message: fixed(EXCLUSIVE_SIDE_EFFECT),
  mcp: byAction({
    exclusive: ['servers'],
    sideEffect: ['connect', 'tools', 'call', 'disconnect'],
  }),
  browser: fixed(EXCLUSIVE_SIDE_EFFECT),
  gh: fixed(PARALLEL_READ),
  openbb_cli: fixed(PARALLEL_READ),
  moomoo_skill: (args) => {
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    if (
      command === 'check_env'
      || command.startsWith('quote/')
      || command.startsWith('trade/get_')
    ) return PARALLEL_READ
    return EXCLUSIVE_SIDE_EFFECT
  },
  trading_agent: byAction({
    parallel: ['status', 'result'],
    sideEffect: ['start', 'continue', 'cancel'],
  }),
  website: byAction({
    parallel: ['status', 'read'],
    sideEffect: ['write', 'delete', 'move', 'publish'],
  }),
  web_search: fixed(PARALLEL_READ),
  fetch_content: (args) => {
    const action = typeof args.action === 'string' ? args.action : ''
    if (action === 'image_url' || action === 'qq_avatar') return EXCLUSIVE_SIDE_EFFECT
    if (['url', 'reddit_list', 'reddit_post'].includes(action)) {
      return args.background === true ? EXCLUSIVE_READ : PARALLEL_READ
    }
    return EXCLUSIVE_SIDE_EFFECT
  },
  workspace_file: byAction({
    parallel: ['list', 'read'],
    sideEffect: ['write', 'replace', 'delete', 'move'],
  }),
  read_file: fixed(PARALLEL_READ),
  skill_editor: byAction({
    exclusive: ['validate', 'list_drafts', 'read_draft'],
    sideEffect: ['draft', 'install', 'delete_draft'],
  }),
  inspect_media: fixed(EXCLUSIVE_READ),
  generate_image: fixed(EXCLUSIVE_SIDE_EFFECT),
})

export function applyBotToolPolicy<T extends Tool>(tool: T): T {
  const policy = BOT_TOOL_POLICIES[tool.name]
  if (!policy) {
    throw new Error(`Missing bot tool policy: ${tool.name}`)
  }
  return { ...tool, policy }
}

export function classifyBotToolPolicy(
  toolName: string,
  args: Record<string, unknown> = {},
): ToolPolicyDecision {
  const policy = BOT_TOOL_POLICIES[toolName]
  return policy ? policy(args) : EXCLUSIVE_SIDE_EFFECT
}
