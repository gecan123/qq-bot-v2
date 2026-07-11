import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { createWorkspaceFileTool } from './workspace-file.js'

describe('workspace_file tool', () => {
  test('creates, reads, replaces, moves, and deletes ordinary text files', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'workspace-file-'))
    try {
      const tool = createWorkspaceFileTool({ rootDir })
      const created = JSON.parse((await tool.execute({
        action: 'write',
        file: 'notes/today.md',
        content: 'alpha beta',
      }, undefined as never)).content as string) as { ok: boolean; revision: string }
      assert.equal(created.ok, true)

      const read = JSON.parse((await tool.execute({
        action: 'read',
        file: 'notes/today.md',
      }, undefined as never)).content as string) as { content: string; revision: string }
      assert.equal(read.content, 'alpha beta')

      const replaced = JSON.parse((await tool.execute({
        action: 'replace',
        file: 'notes/today.md',
        expectedRevision: read.revision,
        oldText: 'beta',
        newText: 'gamma',
      }, undefined as never)).content as string) as { ok: boolean; revision: string }
      assert.equal(replaced.ok, true)

      const moved = JSON.parse((await tool.execute({
        action: 'move',
        source: 'notes/today.md',
        destination: 'drafts/today.md',
        expectedRevision: replaced.revision,
      }, undefined as never)).content as string) as { ok: boolean; revision: string }
      assert.equal(moved.ok, true)
      assert.equal(await readFile(join(rootDir, 'drafts', 'today.md'), 'utf8'), 'alpha gamma')

      const deleted = JSON.parse((await tool.execute({
        action: 'delete',
        file: 'drafts/today.md',
        expectedRevision: moved.revision,
      }, undefined as never)).content as string) as { ok: boolean }
      assert.equal(deleted.ok, true)
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('requires revisions for overwrite and rejects stale revisions', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'workspace-file-revision-'))
    try {
      const tool = createWorkspaceFileTool({ rootDir })
      const created = JSON.parse((await tool.execute({ action: 'write', file: 'notes/a.txt', content: 'one' }, undefined as never)).content as string) as { revision: string }
      const missingRevision = JSON.parse((await tool.execute({ action: 'write', file: 'notes/a.txt', content: 'two' }, undefined as never)).content as string) as { ok: boolean; code: string }
      assert.deepEqual({ ok: missingRevision.ok, code: missingRevision.code }, { ok: false, code: 'revision_required' })

      const overwritten = JSON.parse((await tool.execute({
        action: 'write',
        file: 'notes/a.txt',
        content: 'two',
        expectedRevision: created.revision,
      }, undefined as never)).content as string) as { ok: boolean }
      assert.equal(overwritten.ok, true)
      const stale = JSON.parse((await tool.execute({
        action: 'delete',
        file: 'notes/a.txt',
        expectedRevision: created.revision,
      }, undefined as never)).content as string) as { ok: boolean; code: string }
      assert.deepEqual({ ok: stale.ok, code: stale.code }, { ok: false, code: 'revision_conflict' })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('rejects managed, hidden, repeated-root, binary, and escaping paths', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'workspace-file-paths-'))
    try {
      const tool = createWorkspaceFileTool({ rootDir })
      for (const file of [
        'journal/diary/a.md',
        'life/agenda.md',
        'memory/self/a.md',
        'skill-drafts/a.md',
        'browser/a.txt',
        'data/agent-workspace/notes/a.md',
        '.hidden.md',
        '../outside.md',
        'notes/image.png',
      ]) {
        const result = JSON.parse((await tool.execute({ action: 'write', file, content: 'x' }, undefined as never)).content as string) as { ok: boolean }
        assert.equal(result.ok, false, file)
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('rejects listing through a symlinked directory', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'workspace-file-symlink-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'workspace-file-outside-'))
    try {
      await mkdir(join(rootDir, 'notes'), { recursive: true })
      await symlink(outsideDir, join(rootDir, 'notes', 'linked'))
      const tool = createWorkspaceFileTool({ rootDir })
      const result = JSON.parse((await tool.execute({
        action: 'list',
        directory: 'notes/linked',
      }, undefined as never)).content as string) as { ok: boolean; code: string }
      assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 'symlink_not_allowed' })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('reports list truncation and rejects binary bytes behind a text extension', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'workspace-file-bounded-'))
    try {
      await mkdir(join(rootDir, 'notes'), { recursive: true })
      await writeFile(join(rootDir, 'notes', 'a.md'), 'a', 'utf8')
      await writeFile(join(rootDir, 'notes', 'b.md'), 'b', 'utf8')
      await writeFile(join(rootDir, 'notes', 'binary.txt'), Buffer.from([0xff, 0xfe, 0xfd]))
      const tool = createWorkspaceFileTool({ rootDir })

      const listed = JSON.parse((await tool.execute({
        action: 'list',
        directory: 'notes',
        limit: 1,
      }, undefined as never)).content as string) as { entries: unknown[]; total: number; truncated: boolean }
      assert.equal(listed.entries.length, 1)
      assert.equal(listed.total, 3)
      assert.equal(listed.truncated, true)

      const read = JSON.parse((await tool.execute({
        action: 'read',
        file: 'notes/binary.txt',
      }, undefined as never)).content as string) as { ok: boolean; code: string }
      assert.deepEqual({ ok: read.ok, code: read.code }, { ok: false, code: 'invalid_text' })
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
