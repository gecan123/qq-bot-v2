import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { hasPathEntry } from '../src/ops/repo-path-entry.js'
import { runRepoChecks, type RepoCheckFiles } from '../src/ops/repo-check.js'

function readOptionalFile(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

function readAdminWebSources(directory: string): Record<string, string> {
  if (!existsSync(directory)) return {}
  return Object.fromEntries(
    listTypeScriptFiles(directory).map(path => [path, readFileSync(path, 'utf8')]),
  )
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return listTypeScriptFiles(path)
      return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
    })
}

const files: RepoCheckFiles = {
  'AGENTS.md': readFileSync('AGENTS.md', 'utf8'),
  'CLAUDE.md': readFileSync('CLAUDE.md', 'utf8'),
  'apps/admin-web/AGENTS.md': readOptionalFile('apps/admin-web/AGENTS.md'),
  'apps/admin-web/CLAUDE.md': readOptionalFile('apps/admin-web/CLAUDE.md'),
  adminWebSources: readAdminWebSources('apps/admin-web/src'),
  'README.md': readFileSync('README.md', 'utf8'),
  'package.json': readFileSync('package.json', 'utf8'),
  '.env.example': readFileSync('.env.example', 'utf8'),
  'prompts/groups.md': readFileSync('prompts/groups.md', 'utf8'),
  'src/agent/tools/index.ts': readFileSync('src/agent/tools/index.ts', 'utf8'),
  'src/agent/tools/workspace-bash.ts': readFileSync('src/agent/tools/workspace-bash.ts', 'utf8'),
  'prompts/system/system.md': readFileSync('prompts/system/system.md', 'utf8'),
  'prompts/system/persona.md': readFileSync('prompts/system/persona.md', 'utf8'),
  'prompts/system/owner.md': readFileSync('prompts/system/owner.md', 'utf8'),
  'prompts/chat-style/index.md': readFileSync('prompts/chat-style/index.md', 'utf8'),
  'prompts/chat-style/constraints.md': readFileSync('prompts/chat-style/constraints.md', 'utf8'),
  'prompts/chat-style/base.md': readFileSync('prompts/chat-style/base.md', 'utf8'),
  'prompts/chat-style/anti-patterns.md': readFileSync('prompts/chat-style/anti-patterns.md', 'utf8'),
  'prompts/chat-style/roleplay.md': readFileSync('prompts/chat-style/roleplay.md', 'utf8'),
  'prompts/chat-style/nsfw.md': readFileSync('prompts/chat-style/nsfw.md', 'utf8'),
  ...(hasPathEntry('prompts/bot-system.md')
    ? { 'prompts/bot-system.md': 'present' }
    : {}),
  ...(hasPathEntry('prompts/bot-chat-constraints.md')
    ? { 'prompts/bot-chat-constraints.md': 'present' }
    : {}),
  ...(hasPathEntry('prompts/bot-style.md')
    ? { 'prompts/bot-style.md': 'present' }
    : {}),
  'prisma/schema.prisma': readFileSync('prisma/schema.prisma', 'utf8'),
  'docs/README.md': readFileSync('docs/README.md', 'utf8'),
  'docs/ARCHITECTURE.md': readFileSync('docs/ARCHITECTURE.md', 'utf8'),
  'docs/AGENT_CONTEXT.md': readFileSync('docs/AGENT_CONTEXT.md', 'utf8'),
  'docs/MEMORY_ARCHITECTURE.md': readFileSync('docs/MEMORY_ARCHITECTURE.md', 'utf8'),
  'docs/TOOLS.md': readFileSync('docs/TOOLS.md', 'utf8'),
  'docs/OPERATIONS.md': readFileSync('docs/OPERATIONS.md', 'utf8'),
  'docs/TECH_DEBT.md': readFileSync('docs/TECH_DEBT.md', 'utf8'),
}

const result = runRepoChecks(files)

if (result.errors.length > 0) {
  console.error('repo-check failed:')
  for (const error of result.errors) {
    console.error(`- ${error}`)
  }
  process.exit(1)
}

console.log('repo-check passed')
