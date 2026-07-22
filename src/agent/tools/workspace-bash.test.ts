import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseWorkspaceBashCommand, createWorkspaceBashTool } from './workspace-bash.js'

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
})
