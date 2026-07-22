import 'dotenv/config'
import { existsSync, readFileSync } from 'node:fs'
import { runAgentDoctor, type DoctorFiles } from '../src/ops/agent-doctor.js'
import {
  checkAgentLedger,
  createPrismaAgentLedgerCheckSource,
  type AgentLedgerCheckPrismaClient,
} from '../src/ops/agent-ledger-check.js'
import { createLlmClient } from '../src/agent/llm-client.js'
import { runPersonaSpoofSelfTest } from '../src/agent/persona-spoof-self-test.js'

const paths = [
  'AGENTS.md',
  'CLAUDE.md',
  'package.json',
  'prisma/schema.prisma',
  '.env.example',
  'prompts/groups.md',
  'src/index.ts',
  'src/agent/tools/index.ts',
] as const

const files: DoctorFiles = {}
for (const path of paths) {
  files[path] = existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

const local = runAgentDoctor({ files, env: process.env })
let ledger: Awaited<ReturnType<typeof checkAgentLedger>> | null = null
let ledgerError: string | null = null
let personaSpoof: { ok: boolean; model?: string; sample?: string; error?: string } | null = null
if (local.ok) {
  let prisma: typeof import('../src/database/client.js')['prisma'] | null = null
  try {
    ;({ prisma } = await import('../src/database/client.js'))
    await prisma.$connect()
    ledger = await checkAgentLedger(createPrismaAgentLedgerCheckSource(
      prisma as unknown as AgentLedgerCheckPrismaClient,
    ))
  } catch (error) {
    ledgerError = error instanceof Error ? error.message : String(error)
  } finally {
    await prisma?.$disconnect()
  }

  if (process.env.LLM_DEFAULT_PROVIDER?.trim().toLowerCase() === 'claude-code') {
    try {
      const probe = await runPersonaSpoofSelfTest(createLlmClient(), {
        attempts: 3,
        delayMs: 1_000,
      })
      personaSpoof = {
        ok: true,
        model: probe.model,
        sample: probe.content.slice(0, 40),
      }
    } catch (error) {
      personaSpoof = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
} else {
  ledgerError = 'ledger check skipped until local doctor errors are fixed'
}

const result = {
  ...local,
  ok: local.ok && ledger?.ok === true && personaSpoof?.ok !== false,
  ledger,
  ledgerError,
  personaSpoof,
}

console.log(JSON.stringify(result, null, 2))

if (!result.ok) {
  process.exit(1)
}
