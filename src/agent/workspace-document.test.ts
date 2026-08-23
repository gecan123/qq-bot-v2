import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { assertTextRevision, atomicWriteText, revisionOfText, safeWorkspacePath } from './workspace-document.js'

describe('workspace document infrastructure', () => {
  test('provides shared revision checks and atomic writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-document-'))
    const path = join(root, 'note.md')
    await atomicWriteText(path, 'hello')
    assert.equal(await readFile(path, 'utf8'), 'hello')
    assert.doesNotThrow(() => assertTextRevision('hello', revisionOfText('hello'), () => new Error('conflict')))
    assert.throws(() => assertTextRevision('changed', revisionOfText('hello'), () => new Error('conflict')), /conflict/)
  })

  test('keeps markdown paths inside their workspace root', () => {
    assert.equal(safeWorkspacePath({ rootDir: '/tmp/root', relativeFile: 'topics/a.md' }), '/tmp/root/topics/a.md')
    assert.throws(() => safeWorkspacePath({ rootDir: '/tmp/root', relativeFile: '../escape.md' }), /not allowed/)
    assert.throws(() => safeWorkspacePath({ rootDir: '/tmp/root', relativeFile: 'note.txt' }), /not allowed/)
  })
})
