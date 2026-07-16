import { runAgentContextCli } from '../src/ops/agent-context-cli.js'

const exitCode = await runAgentContextCli(process.argv.slice(2), {
  writeStdout(value) {
    process.stdout.write(value)
  },
  writeStderr(value) {
    process.stderr.write(value)
  },
})

if (exitCode !== 0) process.exitCode = exitCode
