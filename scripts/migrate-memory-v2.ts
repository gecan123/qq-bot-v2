import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { findMemoryEvidenceRows } from '../src/database/messages.js'
import { prisma } from '../src/database/client.js'
import { migrateMemoryToV2 } from '../src/ops/memory-v2-migration.js'

const APPLY_ARG = '--apply'
const PID_FILE = '.bot.pid'
const execFileAsync = promisify(execFile)

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

async function assertBotStopped(projectRoot: string): Promise<void> {
  let raw: string
  try {
    raw = await readFile(PID_FILE, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await assertNoBotProcess(projectRoot)
      return
    }
    throw error
  }
  const pid = Number(raw.trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    await unlink(PID_FILE)
    await assertNoBotProcess(projectRoot)
    return
  }
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      await unlink(PID_FILE)
      await assertNoBotProcess(projectRoot)
      return
    }
    throw error
  }
  throw new Error(`bot is still running (pid=${pid}); stop it before migrating memory v2`)
}

async function assertNoBotProcess(projectRoot: string): Promise<void> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
  const matches = stdout.split('\n').filter((line) => (
    line.includes(projectRoot)
    && /(?:tsx|node).*src\/index\.ts/.test(line)
  ))
  if (matches.length > 0) {
    throw new Error(`bot process still exists without a live pidfile; stop it before migrating memory v2:\n${matches.join('\n')}`)
  }
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
