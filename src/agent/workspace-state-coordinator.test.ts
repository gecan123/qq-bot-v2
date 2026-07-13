import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createWorkspaceStateCoordinator } from './workspace-state-coordinator.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('workspace state coordinator', () => {
  test('serializes writers that use the same resource key', async () => {
    const coordinator = createWorkspaceStateCoordinator()
    const firstEntered = deferred()
    const releaseFirst = deferred()
    const events: string[] = []

    const first = coordinator.withWrite('memory:person/1.md', async () => {
      events.push('first:start')
      firstEntered.resolve()
      await releaseFirst.promise
      events.push('first:end')
    })
    await firstEntered.promise

    const second = coordinator.withWrite('memory:person/1.md', async () => {
      events.push('second:start')
      events.push('second:end')
    })
    await Promise.resolve()

    assert.deepEqual(events, ['first:start'])
    releaseFirst.resolve()
    await Promise.all([first, second])
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end'])
  })

  test('allows writers for different resource keys to overlap', async () => {
    const coordinator = createWorkspaceStateCoordinator()
    const bothEntered = deferred()
    const releaseBoth = deferred()
    let active = 0
    let maxActive = 0

    async function writer(): Promise<void> {
      active += 1
      maxActive = Math.max(maxActive, active)
      if (active === 2) bothEntered.resolve()
      await releaseBoth.promise
      active -= 1
    }

    const first = coordinator.withWrite('memory:person/1.md', writer)
    const second = coordinator.withWrite('memory:person/2.md', writer)
    await bothEntered.promise
    releaseBoth.resolve()
    await Promise.all([first, second])

    assert.equal(maxActive, 2)
  })

  test('releases the resource key when a writer throws', async () => {
    const coordinator = createWorkspaceStateCoordinator()
    const firstEntered = deferred()
    const releaseFirst = deferred()
    let secondRan = false

    const first = coordinator.withWrite('life-agenda:agenda.md', async () => {
      firstEntered.resolve()
      await releaseFirst.promise
      throw new Error('boom')
    })
    await firstEntered.promise
    const second = coordinator.withWrite('life-agenda:agenda.md', async () => {
      secondRan = true
    })

    releaseFirst.resolve()
    await assert.rejects(first, /boom/)
    await second
    assert.equal(secondRan, true)
  })
})
