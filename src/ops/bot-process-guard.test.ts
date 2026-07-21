import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  assertBotStopped,
  inspectBotProcessGuard,
  type BotProcessGuardDependencies,
} from './bot-process-guard.js'

function dependencies(
  overrides: Partial<BotProcessGuardDependencies> = {},
): BotProcessGuardDependencies {
  return {
    readPidFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
    probePid: () => 'missing',
    listProcesses: async () => [],
    removePidFile: async () => undefined,
    ...overrides,
  }
}

describe('inspectBotProcessGuard', () => {
  test('blocks a live pid from the repository pidfile', async () => {
    const result = await inspectBotProcessGuard('/repo', dependencies({
      readPidFile: async () => '42',
      probePid: () => 'live',
    }))

    assert.deepEqual(result, { stopped: false, pid: 42, reason: 'pidfile_live' })
  })

  test('removes a stale pidfile and checks ps fallback', async () => {
    let removed = false
    const result = await inspectBotProcessGuard('/repo', dependencies({
      readPidFile: async () => '42',
      probePid: () => 'missing',
      removePidFile: async () => { removed = true },
      listProcesses: async () => [{ pid: 51, command: 'node /repo/src/index.ts' }],
    }))

    assert.equal(removed, true)
    assert.deepEqual(result, { stopped: false, pid: 51, reason: 'process_scan_match' })
  })

  test('accepts a missing pidfile and empty process scan', async () => {
    const result = await inspectBotProcessGuard('/repo', dependencies())

    assert.deepEqual(result, { stopped: true, pid: null, reason: 'no_process' })
  })

  test('removes an invalid pidfile before checking processes', async () => {
    let removed = false
    const result = await inspectBotProcessGuard('/repo', dependencies({
      readPidFile: async () => 'not-a-pid',
      removePidFile: async () => { removed = true },
    }))

    assert.equal(removed, true)
    assert.deepEqual(result, { stopped: true, pid: null, reason: 'no_process' })
  })

  test('ignores unrelated node processes outside the resolved repository', async () => {
    const result = await inspectBotProcessGuard('/repo', dependencies({
      listProcesses: async () => [
        { pid: 60, command: 'node /other/src/index.ts' },
        { pid: 61, command: 'python /repo/src/index.ts' },
      ],
    }))

    assert.deepEqual(result, { stopped: true, pid: null, reason: 'no_process' })
  })
})

test('assertBotStopped reports the blocking pid and requires the Bot to stop', async () => {
  await assert.rejects(
    assertBotStopped('/repo', dependencies({
      readPidFile: async () => '42',
      probePid: () => 'live',
    })),
    /bot is still running \(pid=42\); stop it before running this operation/,
  )
})
