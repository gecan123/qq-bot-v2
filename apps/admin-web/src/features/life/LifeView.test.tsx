import assert from 'node:assert/strict'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, test } from 'vitest'
import type { LifeSnapshot } from './life.schema.js'
import { LifeView } from './LifeView.js'

afterEach(cleanup)

test('shows Goal, Schedule and background tasks without an Agenda panel', () => {
  const snapshot: LifeSnapshot = {
    schemaVersion: 1,
    generatedAt: '2026-08-26T08:00:00.000Z',
    goal: null,
    schedules: [],
    backgroundTasks: [],
    runtime: {
      lastWakeAt: null,
      updatedAt: null,
      focus: null,
      mailboxCount: 0,
      inboxReadCount: 0,
    },
    notes: [],
  }

  render(<LifeView snapshot={snapshot} isRefreshing={false} refreshFailed={false} />)

  assert.ok(screen.getByText('Goal 与计划'))
  assert.ok(screen.getByText('Schedule / Background Task'))
  assert.equal(screen.queryByText('Life Agenda'), null)
})
