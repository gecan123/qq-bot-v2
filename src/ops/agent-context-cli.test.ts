import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { AGENT_RUNTIME_STATE_SCHEMA_VERSION } from '../agent/agent-ledger.types.js'
import { createEmptyMailboxContinuityState } from '../agent/mailbox-continuity.js'
import {
  buildAgentContextCliOutput,
  type AgentContextCliRuntime,
} from './agent-context-cli.js'

const projectRoot = resolve(import.meta.dirname, '../..')

test('unknown arguments reject before loading runtime', async () => {
  let runtimeLoads = 0
  await assert.rejects(
    buildAgentContextCliOutput(['--watch'], async () => {
      runtimeLoads++
      return fakeRuntime([])
    }),
    /unknown argument: --watch/,
  )
  assert.equal(runtimeLoads, 0)
})

test('successful json output connects, builds the real report, then disconnects', async () => {
  const calls: string[] = []
  const output = await buildAgentContextCliOutput(['--json'], async () => {
    calls.push('load')
    return fakeRuntime(calls)
  })

  assert.deepEqual(calls, ['load', 'connect', 'disconnect'])
  const report = JSON.parse(output) as { schemaVersion: number; messages: { canonical: number } }
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.messages.canonical, 0)
})

test('report failures still disconnect', async () => {
  const calls: string[] = []
  const runtime = fakeRuntime(calls)
  runtime.prisma.botAgentRuntimeState.findUnique = async () => null

  await assert.rejects(
    buildAgentContextCliOutput([], async () => runtime),
    /singleton row is missing/,
  )
  assert.deepEqual(calls, ['connect', 'disconnect'])
})

test('disconnect failure rejects instead of returning an already-built report', async () => {
  const runtime = fakeRuntime([])
  runtime.prisma.$disconnect = async () => { throw new Error('disconnect failure') }

  await assert.rejects(
    buildAgentContextCliOutput([], async () => runtime),
    /disconnect failure/,
  )
})

test('direct script contains missing config failures without a raw stack', async () => {
  const result = await runProcess(process.execPath, [
    '--import',
    'tsx',
    resolve(projectRoot, 'scripts/agent-context.ts'),
    '--json',
  ])

  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assertStructuredError(result.stderr, 'Missing required environment variable: LLM_DEFAULT_PROVIDER')
  assert.equal(result.stderr.includes(projectRoot), false)
})

test('pnpm silent keeps the command-level error channel machine clean', async () => {
  const result = await runProcess('pnpm', ['--silent', 'agent:context', '--', '--json'])

  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assertStructuredError(result.stderr, 'Missing required environment variable: LLM_DEFAULT_PROVIDER')
  assert.equal(result.stderr.includes(projectRoot), false)
})

function fakeRuntime(calls: string[]): AgentContextCliRuntime {
  return {
    config: {
      compaction: { reserveTokens: 10_000, keepRecentTokens: 2_000 },
      llm: {
        defaultProvider: 'openai-agent',
        defaultModel: 'gpt-test',
        contextWindowTokensByModel: { 'gpt-test': 400_000 },
        claudeThinking: { mode: 'disabled', retention: 'active-tool-cycle' },
      },
    },
    prisma: {
      async $connect() { calls.push('connect') },
      async $disconnect() { calls.push('disconnect') },
      botAgentLedgerEntry: { async findMany() { return [] } },
      botAgentRuntimeState: {
        async findUnique() {
          return {
            schemaVersion: AGENT_RUNTIME_STATE_SCHEMA_VERSION,
            mailboxCursors: {},
            inboxReadCursors: {},
            mailboxContinuity: createEmptyMailboxContinuityState(),
            goalRevision: 0,
            activeToolCapabilities: [],
            qqConversationFocus: null,
            lastWakeAt: null,
            ledgerHeadEntryId: null,
          }
        },
      },
      agentTokenUsage: { async findFirst() { return null } },
    },
    imageRefs: {
      async persist() { throw new Error('persist must not be called') },
      async resolve() { return null },
    },
  }
}

function assertStructuredError(stderr: string, expectedMessage: string): void {
  assert.equal(stderr.split('\n').length, 2)
  assert.equal(stderr.endsWith('\n'), true)
  assert.deepEqual(JSON.parse(stderr), {
    ok: false,
    code: 'agent_context_report_failed',
    error: expectedMessage,
  })
  assert.equal(stderr.includes('    at '), false)
}

async function runProcess(command: string, args: string[]): Promise<{
  code: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        DATABASE_URL: '',
        LLM_DEFAULT_PROVIDER: '',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolveResult({ code, stdout, stderr }))
  })
}
