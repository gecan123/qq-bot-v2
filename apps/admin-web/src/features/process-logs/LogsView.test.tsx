import assert from 'node:assert/strict'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, test } from 'vitest'
import type { ProcessLogSnapshot } from './logs.js'
import { LogsView } from './LogsView.js'

afterEach(cleanup)

test('keeps the common log workflow compact and hides technical detail by default', () => {
  const snapshot: ProcessLogSnapshot = {
    schemaVersion: 2,
    generatedAt: '2026-08-20T01:10:12.500Z',
    selectedSource: 'agent-core',
    sources: [
      { id: 'agent-core', label: 'Agent Core', exists: true, sizeBytes: 4096, updatedAt: '2026-08-20T01:10:12.456Z' },
      { id: 'qq-gateway', label: 'QQ Gateway', exists: true, sizeBytes: 2048, updatedAt: '2026-08-20T01:09:00.000Z' },
    ],
    entries: [
      {
        sequence: 1,
        level: 'info',
        timestamp: '2026-08-20T09:10:11.123+08:00',
        scope: 'APP',
        message: '数据库已连接',
        metadata: null,
        detail: null,
        text: 'INFO [2026-08-20T09:10:11.123+08:00]: [APP] 数据库已连接',
      },
      {
        sequence: 2,
        level: 'error',
        timestamp: '2026-08-20T09:10:12.456+08:00',
        scope: 'BOT_LOOP',
        message: 'round_failed_backing_off',
        metadata: { roundIndex: 7 },
        detail: '    error: "Anthropic API 502"',
        text: 'ERROR [2026-08-20T09:10:12.456+08:00]: [BOT_LOOP] round_failed_backing_off {"roundIndex":7}\n    error: "Anthropic API 502"',
      },
    ],
    bytesTruncated: false,
    lineLimitTruncated: false,
    warnings: [],
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })

  render(<QueryClientProvider client={queryClient}><LogsView initialSnapshot={snapshot} /></QueryClientProvider>)

  assert.equal((screen.getByLabelText('日志来源') as HTMLSelectElement).value, 'agent-core')
  assert.ok(screen.getByText('08/20 09:10:11'))
  assert.ok(screen.getByText('数据库已连接'))
  assert.ok(screen.getByText('round_failed_backing_off'))
  assert.equal(screen.getByText('查看详情').closest('details')?.hasAttribute('open'), false)

  fireEvent.click(screen.getByRole('button', { name: '只看问题' }))
  assert.equal(screen.queryByText('数据库已连接'), null)
  assert.ok(screen.getByText('round_failed_backing_off'))
  assert.ok(screen.getByText('1 / 2 条'))
})
