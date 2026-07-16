import { buildAgentContextCliOutput } from '../src/ops/agent-context-cli.js'

try {
  process.stdout.write(`${await buildAgentContextCliOutput(process.argv.slice(2))}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: 'agent_context_report_failed',
    error: error instanceof Error ? error.message : String(error),
  })}\n`)
  process.exitCode = 1
}
