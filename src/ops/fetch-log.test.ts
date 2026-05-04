import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { logFetch, type FetchLogEntry } from './fetch-log.js'

function makeEntry(overrides: Partial<FetchLogEntry> = {}): FetchLogEntry {
  return {
    ts: '2026-05-04T14:00:00.000Z',
    source: 'reddit',
    url: 'https://www.reddit.com/r/programming/hot.rss',
    status: 200,
    bytes: 12345,
    toolCallId: 'call_abc',
    durationMs: 423,
    ...overrides,
  }
}

describe('logFetch', () => {
  test('writes one NDJSON line per call (single trailing newline)', async () => {
    const writes: Array<{ path: string; line: string }> = []
    await logFetch(makeEntry(), {
      path: '/tmp/fake.ndjson',
      appender: async (path, line) => {
        writes.push({ path, line })
      },
    })
    assert.equal(writes.length, 1)
    assert.equal(writes[0]!.path, '/tmp/fake.ndjson')
    const line = writes[0]!.line
    assert.equal(line.endsWith('\n'), true, 'must end with one newline')
    assert.equal(line.includes('\n', 0) ? line.indexOf('\n') === line.length - 1 : false, true)
    const parsed = JSON.parse(line.trim())
    assert.equal(parsed.source, 'reddit')
    assert.equal(parsed.status, 200)
    assert.equal(parsed.toolCallId, 'call_abc')
  })

  test('errorKind round-trips when set', async () => {
    let captured = ''
    await logFetch(makeEntry({ status: -1, errorKind: 'timeout' }), {
      path: '/tmp/fake.ndjson',
      appender: async (_p, line) => {
        captured = line
      },
    })
    const parsed = JSON.parse(captured.trim())
    assert.equal(parsed.errorKind, 'timeout')
    assert.equal(parsed.status, -1)
  })

  test('appender failure does not throw (swallow + log)', async () => {
    await assert.doesNotReject(
      logFetch(makeEntry(), {
        path: '/tmp/fake.ndjson',
        appender: async () => {
          throw new Error('disk full')
        },
      }),
    )
  })

  test('source field can be url too (fetch_url uses source="url")', async () => {
    let captured = ''
    await logFetch(makeEntry({ source: 'url', url: 'https://example.com/article' }), {
      path: '/tmp/fake.ndjson',
      appender: async (_p, line) => {
        captured = line
      },
    })
    const parsed = JSON.parse(captured.trim())
    assert.equal(parsed.source, 'url')
  })
})
