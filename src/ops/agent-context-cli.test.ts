import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  runAgentContextCli,
  type AgentContextCliDependencies,
  type AgentContextCliRuntime,
} from './agent-context-cli.js'

const projectRoot = resolve(import.meta.dirname, '../..')

test('unknown arguments return one structured line without loading runtime or connecting DB', async () => {
  const output = captureOutput()
  let runtimeLoads = 0
  const dependencies: AgentContextCliDependencies = {
    async loadRuntime() {
      runtimeLoads++
      throw new Error('must not load')
    },
    async buildOutput() {
      throw new Error('must not build')
    },
  }

  const exitCode = await runAgentContextCli(['--watch'], output.io, dependencies)

  assert.equal(exitCode, 1)
  assert.equal(runtimeLoads, 0)
  assert.equal(output.stdout, '')
  assertStructuredError(output.stderr, 'unknown argument: --watch')
})

test('runtime initialization failures are contained by the stable error boundary', async () => {
  const output = captureOutput()
  const dependencies: AgentContextCliDependencies = {
    async loadRuntime() {
      throw new Error('missing config\nno stack')
    },
    async buildOutput() {
      throw new Error('must not build')
    },
  }

  const exitCode = await runAgentContextCli(['--json'], output.io, dependencies)

  assert.equal(exitCode, 1)
  assert.equal(output.stdout, '')
  assertStructuredError(output.stderr, 'missing config\nno stack')
  assert.equal(output.stderr.includes(import.meta.dirname), false)
})

test('disconnect errors cannot override a primary failure', async () => {
  const output = captureOutput()
  const calls: string[] = []
  const dependencies = fakeDependencies({
    calls,
    async buildOutput() {
      calls.push('build')
      throw new Error('primary failure')
    },
    async disconnect() {
      calls.push('disconnect')
      throw new Error('disconnect failure')
    },
  })

  const exitCode = await runAgentContextCli([], output.io, dependencies)

  assert.equal(exitCode, 1)
  assert.deepEqual(calls, ['load', 'connect', 'build', 'disconnect'])
  assert.equal(output.stdout, '')
  assertStructuredError(output.stderr, 'primary failure')
})

test('a lone disconnect failure suppresses the report and becomes the stable error', async () => {
  const output = captureOutput()
  const dependencies = fakeDependencies({
    async disconnect() {
      throw new Error('disconnect failure')
    },
  })

  const exitCode = await runAgentContextCli([], output.io, dependencies)

  assert.equal(exitCode, 1)
  assert.equal(output.stdout, '')
  assertStructuredError(output.stderr, 'disconnect failure')
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
  const result = await runProcess('pnpm', [
    '--silent',
    'agent:context',
    '--',
    '--json',
  ])

  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assertStructuredError(result.stderr, 'Missing required environment variable: LLM_DEFAULT_PROVIDER')
  assert.equal(result.stderr.includes(projectRoot), false)
})

function fakeDependencies(overrides: {
  calls?: string[]
  buildOutput?: AgentContextCliDependencies['buildOutput']
  disconnect?: () => Promise<void>
} = {}): AgentContextCliDependencies {
  const calls = overrides.calls ?? []
  const runtime = {
    prisma: {
      async $connect() {
        calls.push('connect')
      },
      async $disconnect() {
        if (overrides.disconnect) return overrides.disconnect()
        calls.push('disconnect')
      },
    },
  } as AgentContextCliRuntime
  return {
    async loadRuntime() {
      calls.push('load')
      return runtime
    },
    buildOutput: overrides.buildOutput ?? (async () => {
      calls.push('build')
      return 'report'
    }),
  }
}

function captureOutput() {
  const capture = {
    stdout: '',
    stderr: '',
    io: {
      writeStdout(value: string) {
        capture.stdout += value
      },
      writeStderr(value: string) {
        capture.stderr += value
      },
    },
  }
  return capture
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
