import { executeAgentDbQueryInput, parseAgentDbQueryInput } from '../src/database/agent-db-query-cli.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const argInput = process.argv.slice(2).join(' ').trim()
  const stdinInput = await readStdin()
  const raw = argInput || stdinInput
  const parsed = parseAgentDbQueryInput(raw)
  const output = await executeAgentDbQueryInput(parsed)
  process.stdout.write(output + '\n')
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + '\n')
  process.exitCode = 1
})
