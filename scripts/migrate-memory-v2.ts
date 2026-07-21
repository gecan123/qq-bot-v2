import { resolve } from 'node:path'
import { findMemoryEvidenceRows } from '../src/database/messages.js'
import { prisma } from '../src/database/client.js'
import { assertBotStopped } from '../src/ops/bot-process-guard.js'
import { migrateMemoryToV2 } from '../src/ops/memory-v2-migration.js'

const APPLY_ARG = '--apply'

async function main(): Promise<void> {
  const apply = process.argv.includes(APPLY_ARG)
  const rootDir = resolve(parseRootArg(process.argv.slice(2)))
  if (apply) await assertBotStopped(resolve('.'))
  const result = await migrateMemoryToV2({
    rootDir,
    apply,
    loadSourceEvidence: findMemoryEvidenceRows,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

function parseRootArg(args: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === APPLY_ARG || arg === '--') continue
    if (arg?.startsWith('--root=')) return arg.slice('--root='.length)
    if (arg === '--root') {
      const value = args[index + 1]
      if (!value) throw new Error('--root requires a path')
      return value
    }
    if (index > 0 && args[index - 1] === '--root') continue
    throw new Error(`unknown argument: ${arg}`)
  }
  return 'data/agent-workspace'
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
