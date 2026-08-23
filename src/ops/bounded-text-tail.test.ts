import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { readBoundedTextTail } from './bounded-text-tail.js'

describe('readBoundedTextTail', () => {
  test('returns a complete small file without truncation', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'bounded-tail-')), 'events.ndjson')
    await writeFile(path, 'first\nsecond\n', 'utf8')
    assert.deepEqual(await readBoundedTextTail(path, 100), {
      content: 'first\nsecond\n',
      truncated: false,
    })
  })

  test('drops the partial first line when reading a bounded tail', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'bounded-tail-')), 'events.ndjson')
    await writeFile(path, 'first-line\nsecond-line\nthird-line\n', 'utf8')
    assert.deepEqual(await readBoundedTextTail(path, 24), {
      content: 'second-line\nthird-line\n',
      truncated: true,
    })
  })
})
