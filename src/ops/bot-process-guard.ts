import { execFile } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type BotProcessGuardResult =
  | { stopped: true; pid: null; reason: 'no_process' }
  | { stopped: false; pid: number; reason: 'pidfile_live' | 'process_scan_match' }

export interface BotProcessGuardDependencies {
  readPidFile(): Promise<string>
  probePid(pid: number): 'live' | 'missing'
  listProcesses(): Promise<Array<{ pid: number; command: string }>>
  removePidFile(): Promise<void>
}

export async function inspectBotProcessGuard(
  repositoryRoot: string,
  dependencies: BotProcessGuardDependencies = nodeDependencies(resolve(repositoryRoot)),
): Promise<BotProcessGuardResult> {
  const root = resolve(repositoryRoot)
  let raw: string | null = null
  try {
    raw = await dependencies.readPidFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  if (raw !== null) {
    const pid = Number(raw.trim())
    if (Number.isSafeInteger(pid) && pid > 0) {
      if (dependencies.probePid(pid) === 'live') {
        return { stopped: false, pid, reason: 'pidfile_live' }
      }
    }
    await dependencies.removePidFile()
  }

  for (const processInfo of await dependencies.listProcesses()) {
    if (
      processInfo.command.includes(root)
      && /(?:^|\s)(?:tsx|node)(?:\s|$)/.test(processInfo.command)
      && /src[/\\]index\.ts(?:\s|$)/.test(processInfo.command)
    ) {
      return { stopped: false, pid: processInfo.pid, reason: 'process_scan_match' }
    }
  }

  return { stopped: true, pid: null, reason: 'no_process' }
}

export async function assertBotStopped(
  repositoryRoot: string,
  dependencies?: BotProcessGuardDependencies,
): Promise<void> {
  const result = await inspectBotProcessGuard(repositoryRoot, dependencies)
  if (!result.stopped) {
    throw new Error(`bot is still running (pid=${result.pid}); stop it before running this operation`)
  }
}

function nodeDependencies(repositoryRoot: string): BotProcessGuardDependencies {
  const pidFile = join(repositoryRoot, '.bot.pid')
  return {
    readPidFile: () => readFile(pidFile, 'utf8'),
    probePid(pid) {
      try {
        process.kill(pid, 0)
        return 'live'
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'missing'
        throw error
      }
    },
    async listProcesses() {
      const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
      return stdout.split('\n').flatMap(line => {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line)
        return match ? [{ pid: Number(match[1]), command: match[2]! }] : []
      })
    },
    removePidFile: () => unlink(pidFile),
  }
}
