export type DoctorFiles = Record<string, string | undefined>
export type DoctorEnv = Record<string, string | undefined>

export interface AgentDoctorInput {
  files: DoctorFiles
  env: DoctorEnv
}

export interface AgentDoctorResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  checks: Array<{ name: string; ok: boolean; message: string }>
}

const REQUIRED_ENV = [
  'DATABASE_URL',
  'NAPCAT_WS_URL',
  'NAPCAT_ACCESS_TOKEN',
  'SELF_NUMBER',
  'LLM_DEFAULT_PROVIDER',
  'LLM_DEFAULT_MODEL',
] as const

const REQUIRED_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'package.json',
  'prisma/schema.prisma',
  '.env.example',
  'src/index.ts',
  'src/agent/tools/index.ts',
] as const

export function runAgentDoctor(input: AgentDoctorInput): AgentDoctorResult {
  const checks: AgentDoctorResult['checks'] = []
  const errors: string[] = []
  const warnings: string[] = []

  for (const path of REQUIRED_FILES) {
    const content = input.files[path]
    const ok = content != null && content.trim().length > 0
    checks.push({ name: `file:${path}`, ok, message: ok ? 'present' : `${path} is empty or missing` })
    if (!ok) errors.push(`${path} is empty or missing`)
  }

  if ((input.files['AGENTS.md'] ?? '') !== (input.files['CLAUDE.md'] ?? '')) {
    checks.push({ name: 'agent-instructions-mirror', ok: false, message: 'AGENTS.md and CLAUDE.md differ' })
    errors.push('AGENTS.md and CLAUDE.md differ')
  } else {
    checks.push({ name: 'agent-instructions-mirror', ok: true, message: 'mirrored' })
  }

  const prismaSchema = input.files['prisma/schema.prisma'] ?? ''
  for (const table of [
    'bot_agent_ledger_entries',
    'bot_agent_runtime_state',
    'bot_agent_checkpoint',
  ]) {
    if (!prismaSchema.includes(`@@map("${table}")`)) {
      errors.push(`prisma/schema.prisma does not map ${table}`)
    }
  }

  if (!(input.files['src/index.ts'] ?? '').includes('createAgentRuntime')) {
    errors.push('src/index.ts does not reference createAgentRuntime')
  }

  if (!(input.files['src/agent/tools/index.ts'] ?? '').includes('buildBotToolManifest')) {
    errors.push('src/agent/tools/index.ts does not reference buildBotToolManifest')
  }

  for (const name of REQUIRED_ENV) {
    if (!hasEnv(input.env, name)) {
      errors.push(`missing env ${name}`)
    }
  }

  const provider = input.env.LLM_DEFAULT_PROVIDER?.trim().toLowerCase()
  if (provider === 'openai-agent') {
    requireProviderEnv(input.env, 'OPENAI', errors)
  } else if (provider === 'claude-code') {
    requireProviderEnv(input.env, 'CLAUDE', errors)
  } else if (provider) {
    errors.push(`unsupported LLM_DEFAULT_PROVIDER ${provider}`)
  }

  if (!hasEnv(input.env, 'BOT_TARGET_GROUP_IDS')) {
    warnings.push('BOT_TARGET_GROUP_IDS is empty; bot will only accept private friend messages')
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checks,
  }
}

function requireProviderEnv(env: DoctorEnv, provider: 'OPENAI' | 'CLAUDE', errors: string[]): void {
  const url = `LLM_PROVIDER_${provider}_URL`
  const key = `LLM_PROVIDER_${provider}_API_KEY`
  if (!hasEnv(env, url)) errors.push(`missing env ${url}`)
  if (!hasEnv(env, key)) errors.push(`missing env ${key}`)
}

function hasEnv(env: DoctorEnv, name: string): boolean {
  return (env[name]?.trim() ?? '').length > 0
}
