import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createLocalWorkspaceCommandRunner,
  parseWorkspaceBashCommand,
  createWorkspaceBashTool,
  type WorkspaceBashRunInput,
} from './workspace-bash.js'

describe('workspace_bash', () => {
  test('accepts only the small read-only command set', () => {
    assert.deepEqual(parseWorkspaceBashCommand('rg -n hello notes'), {
      ok: true, cwd: 'workspace', command: 'rg', args: ['-n', 'hello', 'notes'],
    })
    for (const command of ['rm x', 'db recent_messages', 'fetch url https://example.com', 'cat x > y', 'pwd; id']) {
      assert.equal(parseWorkspaceBashCommand(command).ok, false)
    }
  })

  test('schema defaults to the bounded workspace cwd', () => {
    const tool = createWorkspaceBashTool()
    assert.equal(tool.schema.safeParse({ cwd: 'workspace', command: 'pwd' }).success, true)
    assert.equal(tool.schema.safeParse({ command: 'pwd' }).success, true)
    assert.equal(tool.schema.safeParse({ cwd: 'workspace', command: 'echo hi' }).success, true)
    assert.equal(parseWorkspaceBashCommand('echo hi').ok, false)
    assert.match(tool.description, /不经过 shell/)
  })

  test('local runner revalidates policy and clamps process limits', async () => {
    const processInputs: WorkspaceBashRunInput[] = []
    const runner = createLocalWorkspaceCommandRunner({
      workspaceDir: '/tmp/luna-workspace',
      repoDir: '/tmp/luna-repo',
      maxTimeoutMs: 2_000,
      maxOutputChars: 3_000,
      processRunner: async input => {
        processInputs.push(input)
        return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }
      },
    })

    assert.deepEqual(await runner({
      cwd: 'repo',
      command: 'cat .env',
      timeoutMs: 99_000,
      maxOutputChars: 99_000,
    }), {
      ok: false,
      code: 'command_not_allowed',
      error: 'path is not allowed: .env',
    })
    assert.equal(processInputs.length, 0)

    assert.equal((await runner({
      cwd: 'repo',
      command: 'rg -n hello src',
      timeoutMs: 99_000,
      maxOutputChars: 99_000,
    })).ok, true)
    assert.equal(processInputs[0]?.cwd, '/tmp/luna-repo')
    assert.equal(processInputs[0]?.timeoutMs, 2_000)
    assert.equal(processInputs[0]?.maxOutputChars, 3_000)
    assert.deepEqual(processInputs[0]?.env, { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' })
  })
})
