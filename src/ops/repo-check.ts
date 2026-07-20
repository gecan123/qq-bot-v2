export interface RepoCheckFiles {
  'AGENTS.md': string
  'CLAUDE.md': string
  'apps/admin-web/AGENTS.md'?: string
  'apps/admin-web/CLAUDE.md'?: string
  'README.md': string
  'package.json': string
  '.env.example': string
  'prompts/groups.md': string
  'src/agent/tools/index.ts': string
  'src/agent/tools/workspace-bash.ts': string
  'prompts/bot-system.md': string
  'prompts/bot-chat-constraints.md': string
  'prompts/bot-style.md': string
  'prisma/schema.prisma': string
  'docs/README.md': string
  'docs/ARCHITECTURE.md': string
  'docs/AGENT_CONTEXT.md': string
  'docs/MEMORY_ARCHITECTURE.md': string
  'docs/TOOLS.md': string
  'docs/OPERATIONS.md': string
  'docs/TECH_DEBT.md': string
}

export interface RepoCheckResult {
  errors: string[]
}

const README_REMOVED_SURFACES = [
  'scene_agent_contexts',
  'reply_records',
  'reply_audits',
  'assistant_turns',
  'root_runtime_snapshots',
  'agent_runtime_snapshots',
  'src/conversation/',
  'src/responder/',
  'src/runtime/',
  'src/server/',
]

const REQUIRED_DOCS = [
  'docs/ARCHITECTURE.md',
  'docs/AGENT_CONTEXT.md',
  'docs/MEMORY_ARCHITECTURE.md',
  'docs/TOOLS.md',
  'docs/OPERATIONS.md',
  'docs/TECH_DEBT.md',
] as const

const MAX_AGENT_ENTRY_LINES = 120

const REQUIRED_ENV_MARKERS = [
  'BOT_EVENT_DEBOUNCE_MS',
  'BOT_TOKEN_USAGE_LOG_PATH',
] as const

const TOOL_REGISTRY_MARKERS = [
  ['createDeferredToolExecutor', 'invoke'],
  ['pauseTool', 'pause'],
  ['createSendMessageTool', 'send_message'],
  ['createGenerateImageTool', 'generate_image'],
  ['createBackgroundTaskTool', 'background_task'],
  ['todoTool', 'todo'],
  ['skillTool', 'skill'],
  ['memoryTool', 'memory'],
  ['collectStickerTool', 'collect_sticker'],
  ['createWorkspaceBashTool', 'workspace_bash'],
  ['workspaceFileTool', 'workspace_file'],
  ['maybeCreateBrowserTool', 'browser'],
  ['maybeCreateWebSearchTool', 'web_search'],
] as const

const WORKSPACE_BASH_SUBCOMMAND_MARKERS = [
  ['parseHelpCommand', 'help'],
  ['parseDbToolCommand', 'db'],
  ['parseStyleCommand', 'style'],
  ['parseOpenbbCommand', 'openbb'],
  ['parseFetchCommand', 'fetch'],
  ['parseMetricsCommand', 'metrics'],
] as const

const SYSTEM_PROMPT_EXEMPT_WORKSPACE_BASH_SUBCOMMANDS = new Set(['openbb', 'fetch'])

export function runRepoChecks(files: RepoCheckFiles): RepoCheckResult {
  const errors: string[] = []

  if (files['AGENTS.md'] !== files['CLAUDE.md']) {
    errors.push('AGENTS.md and CLAUDE.md must stay byte-identical mirrors')
  }

  const adminAgents = files['apps/admin-web/AGENTS.md']
  const adminClaude = files['apps/admin-web/CLAUDE.md']
  if ((adminAgents !== undefined || adminClaude !== undefined) && adminAgents !== adminClaude) {
    errors.push('apps/admin-web/AGENTS.md and CLAUDE.md must be byte-identical')
  }

  checkAgentEntry('AGENTS.md', files['AGENTS.md'], errors)
  checkAgentEntry('CLAUDE.md', files['CLAUDE.md'], errors)
  checkDocsMap(files, errors)
  checkToolIndexes(files, errors)
  checkToolBoundaryDocs(files, errors)
  checkPromptSplit(files, errors)
  checkEnvExample(files, errors)
  checkMemoryArchitecture(files, errors)

  for (const surface of README_REMOVED_SURFACES) {
    if (files['README.md'].includes(surface)) {
      errors.push(`README.md references removed surface "${surface}"`)
    }
  }

  if (/(^|[^A-Z0-9_])GROUP_IDS([^A-Z0-9_]|$)/.test(files['README.md'])) {
    errors.push('README.md references stale env var "GROUP_IDS"; use prompts/groups.md')
  }

  if (!files['README.md'].includes('bot_agent_ledger_entries')) {
    errors.push('README.md must document bot_agent_ledger_entries as the persistent LLM ledger')
  }
  if (files['README.md'].includes('bot_agent_snapshot')) {
    errors.push('README.md must not document removed bot_agent_snapshot persistence')
  }

  checkAgentPersistenceSchema(files['prisma/schema.prisma'], errors)

  const packageJson = parsePackageJson(files['package.json'], errors)
  const scripts = packageJson?.scripts
  if (!scripts || typeof scripts !== 'object') {
    errors.push('package.json must define scripts')
    return { errors }
  }

  const repoCheck = (scripts as Record<string, unknown>)['repo-check']
  if (repoCheck !== 'tsx scripts/repo-check.ts') {
    errors.push('package.json must define scripts["repo-check"] as "tsx scripts/repo-check.ts"')
  }

  const agentDoctor = (scripts as Record<string, unknown>)['agent:doctor']
  if (agentDoctor !== 'tsx scripts/agent-doctor.ts') {
    errors.push('package.json must define scripts["agent:doctor"] as "tsx scripts/agent-doctor.ts"')
  }

  const agentMetrics = (scripts as Record<string, unknown>)['agent:metrics']
  if (agentMetrics !== 'tsx scripts/agent-metrics.ts') {
    errors.push('package.json must define scripts["agent:metrics"] as "tsx scripts/agent-metrics.ts"')
  }

  const agentDailyMetrics = (scripts as Record<string, unknown>)['agent:daily-metrics']
  if (agentDailyMetrics !== 'tsx scripts/agent-daily-metrics.ts') {
    errors.push('package.json must define scripts["agent:daily-metrics"] as "tsx scripts/agent-daily-metrics.ts"')
  }

  const agentMemoryCheck = (scripts as Record<string, unknown>)['agent:memory-check']
  if (agentMemoryCheck !== 'tsx scripts/agent-memory-check.ts') {
    errors.push('package.json must define scripts["agent:memory-check"] as "tsx scripts/agent-memory-check.ts"')
  }

  const agentLedgerCheck = (scripts as Record<string, unknown>)['agent:ledger-check']
  if (agentLedgerCheck !== 'tsx scripts/agent-ledger-check.ts') {
    errors.push('package.json must define scripts["agent:ledger-check"] as "tsx scripts/agent-ledger-check.ts"')
  }

  const lint = (scripts as Record<string, unknown>).lint
  if (typeof lint !== 'string' || !lint.includes('repo-check')) {
    errors.push('package.json scripts.lint must run repo-check')
  }

  return { errors }
}

function checkAgentPersistenceSchema(schema: string, errors: string[]): void {
  const requiredModels = [
    ['BotAgentLedgerEntry', 'bot_agent_ledger_entries'],
    ['BotAgentRuntimeState', 'bot_agent_runtime_state'],
    ['BotAgentCheckpoint', 'bot_agent_checkpoint'],
  ] as const
  for (const [model, table] of requiredModels) {
    const pattern = new RegExp(
      `model\\s+${model}\\s*\\{[\\s\\S]*?@@map\\("${table}"\\)[\\s\\S]*?\\}`,
    )
    if (!pattern.test(schema)) {
      errors.push(`prisma/schema.prisma must map ${model} to ${table}`)
    }
  }

  for (const model of ['BotAgentSnapshot', 'BotAgentSnapshotCheckpoint']) {
    if (new RegExp(`(?:^|\\n)model\\s+${model}\\s*\\{`).test(schema)) {
      errors.push(`prisma/schema.prisma must not define legacy model ${model}`)
    }
  }
}

function checkMemoryArchitecture(files: RepoCheckFiles, errors: string[]): void {
  const memoryDoc = files['docs/MEMORY_ARCHITECTURE.md']
  if (!/Markdown.{0,40}(?:事实来源|source of truth)/is.test(memoryDoc)) {
    errors.push('docs/MEMORY_ARCHITECTURE.md must document Markdown as the source of truth')
  }
  if (!/checkpoint/i.test(memoryDoc)) {
    errors.push('docs/MEMORY_ARCHITECTURE.md must document checkpoint recovery')
  }
  if (!/(?:UNTRUSTED_DATA|不可信数据)/i.test(memoryDoc)) {
    errors.push('docs/MEMORY_ARCHITECTURE.md must document auxiliary LLM input as untrusted data')
  }
}

function checkEnvExample(files: RepoCheckFiles, errors: string[]): void {
  const envExample = files['.env.example']
  for (const marker of REQUIRED_ENV_MARKERS) {
    if (!envExample.includes(marker)) {
      errors.push(`.env.example must mention ${marker}`)
    }
  }

  for (const stale of ['BOT_TARGET_GROUP_IDS', 'BOT_GROUP_AMBIENT_SEND_IDS', 'BOT_GROUP_PROMPTS_PATH']) {
    if (envExample.includes(stale)) {
      errors.push(`.env.example must not mention stale group config ${stale}`)
    }
  }
}

function checkPromptSplit(files: RepoCheckFiles, errors: string[]): void {
  const groups = files['prompts/groups.md']
  if (!groups.includes('# 群聊配置') || !groups.includes('- participation:')) {
    errors.push('prompts/groups.md must define readable group participation policies')
  }
  if (!files['prompts/bot-system.md'].includes('style global [constraints|base|anti_patterns|special_cases]')) {
    errors.push('prompts/bot-system.md must point to style global constraints/base/anti_patterns/special_cases')
  }
  if (!files['prompts/bot-chat-constraints.md'].includes('<!-- section:chat_constraints -->')) {
    errors.push('prompts/bot-chat-constraints.md must define section "chat_constraints"')
  }
  if (!files['prompts/bot-style.md'].includes('<!-- section:style_index -->')) {
    errors.push('prompts/bot-style.md must define section "style_index"')
  }
  if (!files['prompts/bot-style.md'].includes('constraints')) {
    errors.push('prompts/bot-style.md index must mention constraints')
  }
}

function checkToolIndexes(files: RepoCheckFiles, errors: string[]): void {
  const toolIndex = files['src/agent/tools/index.ts']
  const workspaceBash = files['src/agent/tools/workspace-bash.ts']
  const toolsDoc = files['docs/TOOLS.md']
  const systemPrompt = files['prompts/bot-system.md']

  for (const [marker, toolName] of TOOL_REGISTRY_MARKERS) {
    if (!toolIndex.includes(marker)) continue
    if (!mentionsToken(toolsDoc, toolName)) {
      errors.push(`docs/TOOLS.md must mention registered tool "${toolName}"`)
    }
  }

  for (const [marker, subcommand] of WORKSPACE_BASH_SUBCOMMAND_MARKERS) {
    if (!workspaceBash.includes(marker)) continue
    if (!mentionsToken(toolsDoc, subcommand)) {
      errors.push(`docs/TOOLS.md must mention workspace_bash subcommand "${subcommand}"`)
    }
    if (!SYSTEM_PROMPT_EXEMPT_WORKSPACE_BASH_SUBCOMMANDS.has(subcommand) && !mentionsToken(systemPrompt, subcommand)) {
      errors.push(`prompts/bot-system.md must mention workspace_bash subcommand "${subcommand}"`)
    }
  }
}

function checkToolBoundaryDocs(files: RepoCheckFiles, errors: string[]): void {
  for (const line of files['docs/TOOLS.md'].split('\n')) {
    if (!line.includes('collect_sticker') || !line.includes('workspace_bash')) continue
    if (/(不是|并非|不要|不能|not|outside|independent|top-level)/i.test(line)) continue
    if (/(子命令|subcommand|belongs under|内置|built-in|command)/i.test(line)) {
      errors.push('docs/TOOLS.md must not document collect_sticker as a workspace_bash subcommand')
      return
    }
  }
}

function mentionsToken(content: string, token: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(token)}([^A-Za-z0-9_]|$)`).test(content)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function checkAgentEntry(path: 'AGENTS.md' | 'CLAUDE.md', content: string, errors: string[]): void {
  const lineCount = content.split('\n').length
  if (lineCount > MAX_AGENT_ENTRY_LINES) {
    errors.push(`${path} should stay short (<= ${MAX_AGENT_ENTRY_LINES} lines); move detail to docs/`)
  }
  if (!content.includes('docs/README.md')) {
    errors.push(`${path} must link docs/README.md`)
  }
  if (!content.includes('docs/AGENT_CONTEXT.md')) {
    errors.push(`${path} must link docs/AGENT_CONTEXT.md`)
  }
}

function checkDocsMap(files: RepoCheckFiles, errors: string[]): void {
  const docsIndex = files['docs/README.md']
  for (const docPath of REQUIRED_DOCS) {
    if (!docsIndex.includes(docPath)) {
      errors.push(`docs/README.md must link ${docPath}`)
    }
    if (files[docPath].trim().length === 0) {
      errors.push(`${docPath} must not be empty`)
    }
  }
}

function parsePackageJson(raw: string, errors: string[]): { scripts?: unknown } | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      errors.push('package.json must be a JSON object')
      return null
    }
    return parsed as { scripts?: unknown }
  } catch (err) {
    errors.push(`package.json must parse as JSON: ${(err as Error).message}`)
    return null
  }
}
