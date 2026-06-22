export interface RepoCheckFiles {
  'AGENTS.md': string
  'CLAUDE.md': string
  'README.md': string
  'package.json': string
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

export function runRepoChecks(files: RepoCheckFiles): RepoCheckResult {
  const errors: string[] = []

  if (files['AGENTS.md'] !== files['CLAUDE.md']) {
    errors.push('AGENTS.md and CLAUDE.md must stay byte-identical mirrors')
  }

  checkAgentEntry('AGENTS.md', files['AGENTS.md'], errors)
  checkAgentEntry('CLAUDE.md', files['CLAUDE.md'], errors)
  checkDocsMap(files, errors)

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
