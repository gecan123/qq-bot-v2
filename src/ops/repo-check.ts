export interface RepoCheckFiles {
  'AGENTS.md': string
  'CLAUDE.md': string
  'README.md': string
  'package.json': string
  'src/agent/tools/index.ts': string
  'src/agent/tools/workspace-bash.ts': string
  'prompts/bot-system.md': string
  'prisma/schema.prisma': string
  'docs/README.md': string
  'docs/ARCHITECTURE.md': string
  'docs/AGENT_CONTEXT.md': string
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
  'admin-web',
  'src/conversation/',
  'src/responder/',
  'src/runtime/',
  'src/server/',
]

const REQUIRED_DOCS = [
  'docs/ARCHITECTURE.md',
  'docs/AGENT_CONTEXT.md',
  'docs/TOOLS.md',
  'docs/OPERATIONS.md',
  'docs/TECH_DEBT.md',
] as const

const MAX_AGENT_ENTRY_LINES = 120

const TOOL_REGISTRY_MARKERS = [
  ['pauseTool', 'pause'],
  ['createSendMessageTool', 'send_message'],
  ['createGenerateImageTool', 'generate_image'],
  ['createBackgroundTaskTool', 'background_task'],
  ['memoryTool', 'memory'],
  ['collectStickerTool', 'collect_sticker'],
  ['createWorkspaceBashTool', 'workspace_bash'],
  ['maybeCreateBrowserTool', 'browser'],
  ['maybeCreateWebSearchTool', 'web_search'],
] as const

const WORKSPACE_BASH_SUBCOMMAND_MARKERS = [
  ['parseHelpCommand', 'help'],
  ['parseJournalCommand', 'journal'],
  ['parseDbToolCommand', 'db'],
  ['parseStyleCommand', 'style'],
  ['parseOpenbbCommand', 'openbb'],
  ['parseFetchCommand', 'fetch'],
] as const

export function runRepoChecks(files: RepoCheckFiles): RepoCheckResult {
  const errors: string[] = []

  if (files['AGENTS.md'] !== files['CLAUDE.md']) {
    errors.push('AGENTS.md and CLAUDE.md must stay byte-identical mirrors')
  }

  checkAgentEntry('AGENTS.md', files['AGENTS.md'], errors)
  checkAgentEntry('CLAUDE.md', files['CLAUDE.md'], errors)
  checkDocsMap(files, errors)
  checkToolIndexes(files, errors)

  for (const surface of README_REMOVED_SURFACES) {
    if (files['README.md'].includes(surface)) {
      errors.push(`README.md references removed surface "${surface}"`)
    }
  }

  if (/(^|[^A-Z0-9_])GROUP_IDS([^A-Z0-9_]|$)/.test(files['README.md'])) {
    errors.push('README.md references stale env var "GROUP_IDS"; use "BOT_TARGET_GROUP_IDS"')
  }

  if (!files['README.md'].includes('bot_agent_snapshot')) {
    errors.push('README.md must document bot_agent_snapshot as the persistent AgentContext table')
  }

  if (!files['prisma/schema.prisma'].includes('@@map("bot_agent_snapshot")')) {
    errors.push('prisma/schema.prisma must map BotAgentSnapshot to bot_agent_snapshot')
  }

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

  const lint = (scripts as Record<string, unknown>).lint
  if (typeof lint !== 'string' || !lint.includes('repo-check')) {
    errors.push('package.json scripts.lint must run repo-check')
  }

  return { errors }
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
    if (!mentionsToken(systemPrompt, subcommand)) {
      errors.push(`prompts/bot-system.md must mention workspace_bash subcommand "${subcommand}"`)
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
