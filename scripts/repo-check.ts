import { readFileSync } from 'node:fs'
import { runRepoChecks, type RepoCheckFiles } from '../src/ops/repo-check.js'

const files: RepoCheckFiles = {
  'AGENTS.md': readFileSync('AGENTS.md', 'utf8'),
  'CLAUDE.md': readFileSync('CLAUDE.md', 'utf8'),
  'README.md': readFileSync('README.md', 'utf8'),
  'package.json': readFileSync('package.json', 'utf8'),
  '.env.example': readFileSync('.env.example', 'utf8'),
  'prompts/groups.md': readFileSync('prompts/groups.md', 'utf8'),
  'src/agent/tools/index.ts': readFileSync('src/agent/tools/index.ts', 'utf8'),
  'src/agent/tools/workspace-bash.ts': readFileSync('src/agent/tools/workspace-bash.ts', 'utf8'),
  'prompts/bot-system.md': readFileSync('prompts/bot-system.md', 'utf8'),
  'prompts/bot-chat-constraints.md': readFileSync('prompts/bot-chat-constraints.md', 'utf8'),
  'prompts/bot-style.md': readFileSync('prompts/bot-style.md', 'utf8'),
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
