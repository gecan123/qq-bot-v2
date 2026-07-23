import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { WorkspaceExecutorClient } from './client.js'
import type { WorkspaceCommandRunner } from './protocol.js'
import { startWorkspaceExecutorServer } from './server.js'

describe('WorkspaceCommandRunner', () => {
  test('HTTP client sends only the high-level command contract', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const client = new WorkspaceExecutorClient({
      baseUrl: 'http://127.0.0.1:37922/',
      token: 'secret',
      timeoutMs: 1_000,
      fetcher: async (url, init) => {
        capturedUrl = String(url)
        capturedInit = init
        return new Response(JSON.stringify({
          ok: true,
          exitCode: 0,
          stdout: 'notes.md\n',
          stderr: '',
          timedOut: false,
        }), { status: 200 })
      },
    })

    const result = await client.run({
      cwd: 'workspace',
      command: 'ls notes',
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
    })

    assert.equal(capturedUrl, 'http://127.0.0.1:37922/run')
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      cwd: 'workspace',
      command: 'ls notes',
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
    })
    assert.equal(new Headers(capturedInit?.headers).get('authorization'), 'Bearer secret')
    assert.equal(result.ok, true)
  })

  test('server enforces its bearer token before invoking the runner', async () => {
    let calls = 0
    const runner: WorkspaceCommandRunner = async () => {
      calls++
      return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }
    const server = await startWorkspaceExecutorServer({
      host: '127.0.0.1',
      port: 0,
      token: 'secret',
      runner,
    })
    const address = server.address()
    assert.ok(address && typeof address === 'object')

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: 'repo', command: 'pwd', timeoutMs: 1_000, maxOutputChars: 1_000 }),
      })
      assert.equal(response.status, 401)
      assert.equal(calls, 0)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
