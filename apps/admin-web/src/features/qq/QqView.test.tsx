import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, test, vi } from 'vitest'
import type { QqSnapshot } from './qq.schema.js'
import { QqView } from './QqView.js'

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }))

afterEach(cleanup)

test('finds a group or recent message from one search', () => {
  const snapshot: QqSnapshot = {
    schemaVersion: 1,
    generatedAt: '2026-08-20T08:00:00.000Z',
    counts: { messages: 2, groups: 2, media: 0, stickers: 0 },
    groups: [
      { groupId: '1', name: '普通群', messageCount: 1, lastAt: '2026-08-20T08:00:00.000Z' },
      { groupId: '2', name: '设计讨论组', messageCount: 1, lastAt: '2026-08-20T08:00:00.000Z' },
    ],
    messages: [
      { id: 1, scene: '普通群', sceneKind: 'qq_group', sender: 'Alice', senderId: '1', at: '2026-08-20T08:00:00.000Z', text: 'hello', mediaReferenceIds: [] },
      { id: 2, scene: '设计讨论组', sceneKind: 'qq_group', sender: 'Bob', senderId: '2', at: '2026-08-20T08:00:00.000Z', text: 'navigation review', mediaReferenceIds: [] },
    ],
    media: [],
    note: '只读',
  }

  render(<QqView snapshot={snapshot} isRefreshing={false} refreshFailed={false} />)
  fireEvent.change(screen.getByLabelText('搜索 QQ'), { target: { value: '设计' } })

  assert.ok(screen.getAllByText('设计讨论组').length >= 1)
  assert.equal(screen.queryByText('普通群'), null)
  assert.match(screen.getByText(/个群/, { selector: '.filter-count' }).textContent ?? '', /1 \/ 2 个群/)
})
