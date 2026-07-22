export interface RepoCheckFiles {
  'AGENTS.md': string
  'CLAUDE.md': string
  'apps/admin-web/AGENTS.md'?: string
  'apps/admin-web/CLAUDE.md'?: string
  adminWebSources?: Readonly<Record<string, string>>
  'README.md': string
  'package.json': string
  '.env.example': string
  'prompts/groups.md': string
  'src/agent/tools/index.ts': string
  'src/agent/tools/workspace-bash.ts': string
  'prompts/system/system.md': string
  'prompts/system/persona.md': string
  'prompts/system/owner.md': string
  'prompts/chat-style/index.md': string
  'prompts/chat-style/constraints.md': string
  'prompts/chat-style/base.md': string
  'prompts/chat-style/anti-patterns.md': string
  'prompts/chat-style/roleplay.md': string
  'prompts/chat-style/nsfw.md': string
  'prompts/bot-system.md'?: string
  'prompts/bot-chat-constraints.md'?: string
  'prompts/bot-style.md'?: string
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
  'BOT_OBSERVABILITY_RETENTION_DAYS',
] as const

const TOOL_REGISTRY_MARKERS = [
  ['createDeferredToolExecutor', 'invoke'],
  ['yieldTool', 'yield'],
  ['createSendMessageTool', 'send_message'],
  ['createGenerateImageTool', 'generate_image'],
  ['createBackgroundTaskTool', 'background_task'],
  ['skillTool', 'skill'],
  ['memoryTool', 'memory'],
  ['collectStickerTool', 'collect_sticker'],
  ['createWorkspaceBashTool', 'workspace_bash'],
  ['workspaceFileTool', 'workspace_file'],
  ['maybeCreateBrowserTool', 'browser'],
  ['maybeCreateWebSearchTool', 'web_search'],
] as const

const MAIN_AGENT_FORBIDDEN_TOOL_MARKERS = [
  ['createGhTool', 'gh'],
  ['createDbTool', 'db'],
  ['createMetricsTool', 'metrics'],
  ['createSkillEditorTool', 'skill_editor'],
] as const

const ADMIN_WEB_SERVER_ONLY_MARKERS = [
  '@prisma/',
  'node:',
  '../../../../src/generated/prisma/',
  'src/database/',
  'process.env',
] as const

const ADMIN_WEB_MUTATION_MARKERS = [
  '.create(',
  '.createMany(',
  '.update(',
  '.updateMany(',
  '.upsert(',
  '.delete(',
  '.deleteMany(',
  '.$executeRaw(',
] as const

const PUBLIC_STYLE_THEMES = ['constraints', 'base', 'anti_patterns', 'roleplay', 'nsfw'] as const

const STANDALONE_PROMPT_PATHS = [
  'prompts/system/system.md',
  'prompts/system/persona.md',
  'prompts/system/owner.md',
  'prompts/chat-style/index.md',
  'prompts/chat-style/constraints.md',
  'prompts/chat-style/base.md',
  'prompts/chat-style/anti-patterns.md',
  'prompts/chat-style/roleplay.md',
  'prompts/chat-style/nsfw.md',
] as const

const LEGACY_PROMPT_PATHS = [
  'prompts/bot-system.md',
  'prompts/bot-chat-constraints.md',
  'prompts/bot-style.md',
] as const

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
  checkPromptLayout(files, errors)
  checkEnvExample(files, errors)
  checkMemoryArchitecture(files, errors)
  checkAdminWebSources(files.adminWebSources ?? {}, errors)

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

  const agentResetState = (scripts as Record<string, unknown>)['agent:reset-state']
  if (agentResetState !== 'tsx scripts/reset-agent-state.ts --confirm') {
    errors.push('package.json must define scripts["agent:reset-state"] as "tsx scripts/reset-agent-state.ts --confirm"')
  }
  if ('agent:reset-memory' in scripts) {
    errors.push('package.json must not define legacy scripts["agent:reset-memory"]')
  }

  const lint = (scripts as Record<string, unknown>).lint
  if (typeof lint !== 'string' || !lint.includes('repo-check')) {
    errors.push('package.json scripts.lint must run repo-check')
  }

  return { errors }
}

function checkAdminWebSources(
  sources: Readonly<Record<string, string>>,
  errors: string[],
): void {
  for (const [path, source] of Object.entries(sources).sort(([left], [right]) => left.localeCompare(right))) {
    const normalizedPath = path.replaceAll('\\', '/')
    if (!normalizedPath.startsWith('apps/admin-web/src/')) continue

    if (isAdminWebBrowserProductionSource(normalizedPath)) {
      for (const marker of ADMIN_WEB_SERVER_ONLY_MARKERS) {
        if (source.includes(marker)) {
          const reference = describeAdminWebServerOnlyReference(source, marker)
          errors.push(`${normalizedPath} must not reference server-only API "${reference}"`)
        }
      }
    }

    if (
      normalizedPath.includes('/src/features/')
      && /\.(?:server|functions)\.tsx?$/.test(normalizedPath)
    ) {
      const operationsServer = normalizedPath === 'apps/admin-web/src/features/operations/operations.server.ts'
      if (!operationsServer) {
        for (const marker of ADMIN_WEB_MUTATION_MARKERS) {
          if (source.includes(marker)) {
            errors.push(`${normalizedPath} must stay read-only; found Prisma mutation "${marker}"`)
          }
        }
      } else {
        if (!source.startsWith("import '@tanstack/react-start/server-only'")) {
          errors.push(`${normalizedPath} must start with the server-only import`)
        }
        if (!source.includes('resetAgentState')) {
          errors.push(`${normalizedPath} must use the typed resetAgentState service`)
        }
        for (const marker of [
          'node:child_process',
          'execFile(',
          'spawn(',
          'scripts/',
          '$executeRaw',
          '$queryRaw',
        ]) {
          if (source.includes(marker)) {
            errors.push(`${normalizedPath} must not use generic execution marker "${marker}"`)
          }
        }
      }
    }
  }
}

function describeAdminWebServerOnlyReference(
  source: string,
  marker: (typeof ADMIN_WEB_SERVER_ONLY_MARKERS)[number],
): string {
  if (marker === '@prisma/') return source.match(/@prisma\/[A-Za-z0-9_.-]+/)?.[0] ?? marker
  if (marker === 'node:') return source.match(/node:[A-Za-z0-9_./-]+/)?.[0] ?? marker
  return marker
}

function isAdminWebBrowserProductionSource(path: string): boolean {
  return !(
    /\.server\.tsx?$/.test(path)
    || /\.test\.tsx?$/.test(path)
    || path.endsWith('/routeTree.gen.ts')
  )
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

function checkPromptLayout(files: RepoCheckFiles, errors: string[]): void {
  const groups = files['prompts/groups.md']
  if (!groups.includes('# 群聊配置') || !groups.includes('- participation:')) {
    errors.push('prompts/groups.md must define readable group participation policies')
  }

  const styleIndex = files['prompts/chat-style/index.md']
  for (const theme of PUBLIC_STYLE_THEMES) {
    if (!mentionsToken(styleIndex, theme)) {
      errors.push(`prompts/chat-style/index.md must mention public theme "${theme}"`)
    }
  }

  if (!files['prompts/chat-style/constraints.md'].includes('单条消息 ≤ 500 字')) {
    errors.push('prompts/chat-style/constraints.md must define the 500-character message limit')
  }

  const systemPrompt = files['prompts/system/system.md']
  if (!mentionsToken(systemPrompt, 'chat_style')) {
    errors.push('prompts/system/system.md must mention the typed chat_style route')
  }
  if (!/(?:全局)?风格索引/.test(systemPrompt)) {
    errors.push('prompts/system/system.md must point to the style index')
  }
  const enumeratesAllStyleTopics = PUBLIC_STYLE_THEMES.every(
    theme => mentionsToken(systemPrompt, theme),
  )
  if (enumeratesAllStyleTopics) {
    errors.push('prompts/system/system.md must not enumerate all style topics')
  }

  for (const path of STANDALONE_PROMPT_PATHS) {
    if (/<!--\s*\/?section:/i.test(files[path])) {
      errors.push(`${path}: standalone prompt files must not contain section markers`)
    }
  }

  for (const path of LEGACY_PROMPT_PATHS) {
    if (files[path] !== undefined) {
      errors.push(`${path}: must not keep legacy prompt file`)
    }
  }
}

function checkToolIndexes(files: RepoCheckFiles, errors: string[]): void {
  const toolIndex = files['src/agent/tools/index.ts']
  const toolsDoc = files['docs/TOOLS.md']

  for (const [marker, toolName] of TOOL_REGISTRY_MARKERS) {
    if (!toolIndex.includes(marker)) continue
    if (!mentionsToken(toolsDoc, toolName)) {
      errors.push(`docs/TOOLS.md must mention registered tool "${toolName}"`)
    }
  }

  for (const [marker, toolName] of MAIN_AGENT_FORBIDDEN_TOOL_MARKERS) {
    if (toolIndex.includes(marker)) {
      errors.push(`src/agent/tools/index.ts must keep operator tool "${toolName}" out of the main Agent`)
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
