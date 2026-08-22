import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, test } from 'vitest'
import type { TimelineSnapshot } from './timeline.schema.js'
import { TimelineView } from './TimelineView.js'

afterEach(cleanup)

test('filters events by text and event kind', () => {
  const snapshot: TimelineSnapshot = {
    schemaVersion: 1,
    generatedAt: '2026-08-20T08:00:00.000Z',
    summary: { ledger: 1, tools: 1, failedTools: 0, sideEffects: 0, tokenEvents: 1 },
    warning: '关联仅作观察',
    events: [
      { key: 'a', at: '2026-08-20T08:00:00.000Z', kind: 'ledger', title: '收到输入', detail: 'hello', jsonDetail: null, ok: null, sideEffect: null, roundIndex: null, correlation: 'canonical' },
      { key: 'b', at: '2026-08-20T08:00:00.000Z', kind: 'tool', title: '搜索网页', detail: 'needle query', jsonDetail: null, ok: true, sideEffect: false, roundIndex: 1, correlation: 'toolCallId' },
      { key: 'c', at: '2026-08-20T08:00:00.000Z', kind: 'token', title: 'Token 用量', detail: '100', jsonDetail: null, ok: true, sideEffect: false, roundIndex: 1, correlation: 'roundIndex_best_effort' },
    ],
  }

  render(<TimelineView snapshot={snapshot} isRefreshing={false} refreshFailed={false} />)
  fireEvent.change(screen.getByLabelText('事件类型'), { target: { value: 'tool' } })
  fireEvent.change(screen.getByLabelText('搜索事件'), { target: { value: 'needle' } })

  assert.ok(screen.getByText('搜索网页'))
  assert.equal(screen.queryByText('收到输入'), null)
  assert.ok(screen.getByText('1 / 3 个事件'))
})
