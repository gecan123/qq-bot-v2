import { checkAgentMemory, memoryCheckExitCode } from '../src/ops/agent-memory-check.js'

const rootDir = parseRootArg(process.argv.slice(2))

try {
  const report = await checkAgentMemory({ rootDir })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = memoryCheckExitCode(report)
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2))
  process.exitCode = 1
}

function parseRootArg(args: string[]): string {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') continue
    if (arg?.startsWith('--root=')) return arg.slice('--root='.length)
    if (arg === '--root') {
      const value = args[index + 1]
      if (!value) throw new Error('--root requires a path')
      return value
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return 'data/agent-workspace'
}
