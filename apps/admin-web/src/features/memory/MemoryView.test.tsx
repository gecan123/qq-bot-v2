import assert from 'node:assert/strict'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, test, vi } from 'vitest'
import type { MemorySnapshot } from './memory.schema.js'
import { MemoryView } from './MemoryView.js'

vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }))

afterEach(cleanup)

test('filters knowledge files and entries with one search', () => {
  const snapshot: MemorySnapshot = {
    schemaVersion: 1,
    generatedAt: '2026-08-20T08:00:00.000Z',
    counts: { files: 2, memoryEntries: 2, notebookEntries: 0, sourceLinks: 0 },
    files: [
      { fileId: 'one', path: 'memory/alpha.md', kind: 'memory', updatedAt: '2026-08-20T08:00:00.000Z', size: 10, entryCount: 1 },
      { fileId: 'two', path: 'memory/beta.md', kind: 'memory', updatedAt: '2026-08-20T08:00:00.000Z', size: 10, entryCount: 1 },
    ],
    entries: [
      { id: 'alpha', fileId: 'one', file: 'memory/alpha.md', tier: 'stable', status: 'active', evidenceKind: null, updatedAt: null, sourceMessageIds: [], text: '普通内容' },
      { id: 'beta', fileId: 'two', file: 'memory/beta.md', tier: 'stable', status: 'active', evidenceKind: null, updatedAt: null, sourceMessageIds: [], text: 'needle 目标内容' },
    ],
    provenance: [],
    warnings: [],
  }

  render(<MemoryView snapshot={snapshot} isRefreshing={false} refreshFailed={false} />)
  fireEvent.change(screen.getByLabelText('搜索知识'), { target: { value: 'needle' } })

  assert.ok(screen.getByText('needle 目标内容'))
  assert.equal(screen.queryByText('普通内容'), null)
  assert.match(screen.getByText(/条目/, { selector: '.filter-count' }).textContent ?? '', /1 \/ 2 条目/)
})
