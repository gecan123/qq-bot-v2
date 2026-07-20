import { readFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  parseAgentStateResetScope,
  resetAgentState,
} from '../src/ops/reset-agent-state.js'

const PID_FILE = '.bot.pid'

function assertExplicitConfirmation(): void {
  if (process.argv.includes('--confirm')) return
  throw new Error(
    'agent state reset is destructive; use `pnpm agent:reset-state -- --scope all|context|knowledge`',
  )
}

async function assertBotStopped(): Promise<void> {
  let raw: string
  try {
    raw = await readFile(PID_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  const pid = Number(raw.trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    await unlink(PID_FILE)
    return
  }

  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      await unlink(PID_FILE)
      return
    }
    throw error
  }

  throw new Error(`bot is still running (pid=${pid}); stop it before resetting state`)
}

async function main(): Promise<void> {
  assertExplicitConfirmation()
  const scope = parseAgentStateResetScope(process.argv.slice(2))
  await assertBotStopped()
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
