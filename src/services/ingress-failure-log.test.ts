import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { readRecentIngressFailures, recordIngressFailure } from './ingress-failure-log.js'

describe('ingress failure log', () => {
  test('reports recent final failures and ignores older records', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ingress-failure-')), 'failures.ndjson')
    await recordIngressFailure({ path, platform: 'qq', kind: 'message', error: Object.assign(new Error(), { code: 'P1001' }), now: new Date('2026-08-20T00:00:00Z') })
    await recordIngressFailure({ path, platform: 'feishu', kind: 'recall', error: new TypeError('bad'), now: new Date('2026-08-23T00:00:00Z') })
    assert.deepEqual(await readRecentIngressFailures({ path, now: new Date('2026-08-23T01:00:00Z') }), {
      status: 'available', count: 1, truncated: false, invalidLines: 0,
      lastFailedAt: '2026-08-23T00:00:00.000Z', lastErrorKind: 'TypeError',
    })
  })

  test('distinguishes missing and invalid logs from a healthy empty log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ingress-failure-status-'))
    assert.equal((await readRecentIngressFailures({ path: join(root, 'missing.ndjson') })).status, 'missing')
    const directoryPath = join(root, 'directory')
    await mkdir(directoryPath)
    assert.equal((await readRecentIngressFailures({ path: directoryPath })).status, 'invalid')
  })

  test('marks bounded-tail results as truncated and counts invalid lines', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'ingress-failure-tail-')), 'failures.ndjson')
    await writeFile(path, [
      JSON.stringify({ schemaVersion: 1, failedAt: '2026-08-23T00:00:00.000Z', platform: 'qq', kind: 'message', errorKind: 'P1001', context: {} }),
      'not-json',
      JSON.stringify({ schemaVersion: 1, failedAt: '2026-08-23T00:01:00.000Z', platform: 'qq', kind: 'message', errorKind: 'P1002', context: {} }),
    ].join('\n') + '\n', 'utf8')

    const result = await readRecentIngressFailures({
      path,
      now: new Date('2026-08-23T01:00:00Z'),
      maxBytes: 180,
    })
    assert.equal(result.status, 'available')
    assert.equal(result.truncated, true)
    assert.equal(result.invalidLines, 1)
    assert.equal(result.count, 1)
    assert.equal(result.lastErrorKind, 'P1002')
  })
})
