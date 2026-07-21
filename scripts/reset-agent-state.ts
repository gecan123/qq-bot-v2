import { resolve } from 'node:path'
import {
  parseAgentStateResetScope,
  resetAgentState,
} from '../src/ops/reset-agent-state.js'
import { assertBotStopped } from '../src/ops/bot-process-guard.js'

function assertExplicitConfirmation(): void {
  if (process.argv.includes('--confirm')) return
  throw new Error(
    'agent state reset is destructive; use `pnpm agent:reset-state -- --scope all|context|knowledge`',
  )
}

async function main(): Promise<void> {
  assertExplicitConfirmation()
  const scope = parseAgentStateResetScope(process.argv.slice(2))
  await assertBotStopped(resolve('.'))
  const needsDatabase = scope === 'all' || scope === 'context'
  const prisma = needsDatabase ? (await import('../src/database/client.js')).prisma : null
  if (prisma) await prisma.$connect()
  try {
    const result = await resetAgentState({
      scope,
      workspaceDir: resolve('data/agent-workspace'),
      ...(prisma ? { db: prisma } : {}),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
  } finally {
    await prisma?.$disconnect()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
