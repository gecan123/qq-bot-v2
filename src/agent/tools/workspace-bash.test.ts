import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../tool.js'
import type { BotEvent } from '../event.js'
import { InMemoryEventQueue } from '../event-queue.js'
import {
  createWorkspaceBashTool,
  parseWorkspaceBashCommand,
  runWorkspaceBashCommand,
  type WorkspaceBashRunner,
} from './workspace-bash.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 0 }
}

describe('workspace_bash command parser', () => {
  test('accepts simple workspace file commands', () => {
    assert.deepEqual(parseWorkspaceBashCommand('pwd'), {
      ok: true,
      kind: 'workspace',
      cwd: 'workspace',
      command: 'pwd',
      args: [],
    })

    assert.deepEqual(parseWorkspaceBashCommand("printf 'hello\\n' > notes/today.md"), {
      ok: true,
      kind: 'workspace',
      cwd: 'workspace',
      command: 'printf',
      args: ['hello\\n'],
      redirect: { mode: 'write', path: 'notes/today.md' },
    })
  })

  test('accepts only the db query package script for database access', () => {
    assert.deepEqual(parseWorkspaceBashCommand('pnpm db:query \'{"sql":"select 1","params":{}}\''), {
      ok: true,
      kind: 'db_query',
      cwd: 'workspace',
      args: ['{"sql":"select 1","params":{}}'],
    })
  })

  test('accepts read-only repo code inspection commands', () => {
    assert.deepEqual(parseWorkspaceBashCommand('rg "buildBotTools" src/agent/tools/index.ts', 'repo'), {
      ok: true,
      kind: 'workspace',
      cwd: 'repo',
      command: 'rg',
      args: ['buildBotTools', 'src/agent/tools/index.ts'],
    })

    assert.deepEqual(parseWorkspaceBashCommand('rg --files src/agent/tools', 'repo'), {
      ok: true,
      kind: 'workspace',
      cwd: 'repo',
      command: 'rg',
      args: ['--files', 'src/agent/tools'],
    })
  })

  test('rejects shell escapes, disallowed commands, and path escapes', () => {
    const rejected = [
      'cat .env',
      'cat ../.env',
      'cat /etc/passwd',
      'curl https://example.com',
      'psql "$DATABASE_URL"',
      'node -e "console.log(process.env)"',
      'ls && cat .env',
      'printf hi > ../leak.txt',
      'pnpm test',
      'find .',
      "sed -n '1,5p' notes.md",
    ]

    for (const command of rejected) {
      const parsed = parseWorkspaceBashCommand(command)
      assert.equal(parsed.ok, false, `${command} should be rejected`)
    }
  })

  test('rejects repo writes and sensitive repo paths', () => {
    const rejected = [
      "printf 'note' > notes.md",
      'mkdir tmp',
      'touch src/new.ts',
      'cat .env',
      'cat logs/tool-calls.ndjson',
      'cat prompts/groups.yaml',
      'cat data/agent-workspace/journal.md',
      'cat node_modules/.bin/tsx',
      'cat .git/config',
      'cat ../qq-bot-v2/package.json',
    ]

    for (const command of rejected) {
      const parsed = parseWorkspaceBashCommand(command, 'repo')
      assert.equal(parsed.ok, false, `${command} should be rejected in repo mode`)
    }
  })

  test('rejects shell-capable or write-capable command surfaces in repo mode', () => {
    const rejected = [
      'find .',
      "find . -exec sh -c 'cat .env' +",
      "rg --pre 'sh -c cat .env' x src",
      'rg -uuu BOT_OWNER .',
      "sed -i '' s/foo/bar/ src/agent/tools/index.ts",
    ]

    for (const command of rejected) {
      const parsed = parseWorkspaceBashCommand(command, 'repo')
      assert.equal(parsed.ok, false, `${command} should be rejected in repo mode`)
    }
  })
})

describe('workspace_bash tool', () => {
  test('runs accepted commands in the configured workspace with minimal env', async () => {
    let captured: Parameters<WorkspaceBashRunner>[0] | null = null
    const runner: WorkspaceBashRunner = async (input) => {
      captured = input
      return { exitCode: 0, stdout: 'notes\n', stderr: '', timedOut: false }
    }
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      runner,
    })

    const result = await tool.execute({ command: 'ls notes' }, makeCtx())

    assert.equal(result.content, 'notes\n')
    assert.deepEqual(captured, {
      executable: 'ls',
      args: ['notes'],
      cwd: '/tmp/agent-workspace',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdin: undefined,
      timeoutMs: 5000,
      maxOutputChars: 4000,
    })
  })

  test('runs repo inspection commands in repo cwd', async () => {
    let captured: Parameters<WorkspaceBashRunner>[0] | null = null
    const runner: WorkspaceBashRunner = async (input) => {
      captured = input
      return { exitCode: 0, stdout: 'src/agent/tools/index.ts:37:export function buildBotTools', stderr: '', timedOut: false }
    }
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      runner,
    })

    const result = await tool.execute({ cwd: 'repo', command: 'rg "buildBotTools" src/agent/tools/index.ts' }, makeCtx())

    assert.match(result.content as string, /buildBotTools/)
    assert.deepEqual(captured, {
      executable: 'rg',
      args: ['buildBotTools', 'src/agent/tools/index.ts'],
      cwd: '/repo',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdin: undefined,
      timeoutMs: 5000,
      maxOutputChars: 4000,
    })
  })

  test('routes pnpm db:query through repo cwd instead of workspace cwd', async () => {
    let captured: Parameters<WorkspaceBashRunner>[0] | null = null
    const runner: WorkspaceBashRunner = async (input) => {
      captured = input
      return { exitCode: 0, stdout: '{"rows":[[1]]}', stderr: '', timedOut: false }
    }
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      runner,
    })

    const result = await tool.execute({ command: 'pnpm db:query \'{"sql":"select 1","params":{}}\'' }, makeCtx())

    assert.equal(result.content, '{"rows":[[1]]}')
    assert.deepEqual(captured, {
      executable: 'pnpm',
      args: ['db:query', '{"sql":"select 1","params":{}}'],
      cwd: '/repo',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      stdin: undefined,
      timeoutMs: 8000,
      maxOutputChars: 8000,
    })
  })

  test('returns structured error without executing rejected commands', async () => {
    const tool = createWorkspaceBashTool({
      workspaceDir: '/tmp/agent-workspace',
      repoDir: '/repo',
      runner: async () => {
        throw new Error('runner should not be called')
      },
    })

    const result = await tool.execute({ command: 'cat .env' }, makeCtx())
    const parsed = JSON.parse(result.content as string)

    assert.equal(parsed.ok, false)
    assert.match(parsed.error, /not allowed/i)
  })
})

describe('runWorkspaceBashCommand', () => {
  test('writes printf output through controlled redirection inside workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workspace-bash-'))
    try {
      const parsed = parseWorkspaceBashCommand("printf 'hello' > notes/today.md")
      assert.equal(parsed.ok, true)
      if (!parsed.ok || parsed.kind !== 'workspace') return

      const result = await runWorkspaceBashCommand(parsed, {
        workspaceDir: workspace,
        repoDir: workspace,
        timeoutMs: 1000,
        maxOutputChars: 1000,
      })

      assert.equal(result.exitCode, 0)

      const read = parseWorkspaceBashCommand('cat notes/today.md')
      assert.equal(read.ok, true)
      if (!read.ok || read.kind !== 'workspace') return
      const readResult = await runWorkspaceBashCommand(read, {
        workspaceDir: workspace,
        repoDir: workspace,
        timeoutMs: 1000,
        maxOutputChars: 1000,
      })
      assert.equal(readResult.stdout, 'hello')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
