import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hasPathEntry } from './repo-path-entry.js'

test('detects a dangling symlink without following its missing target', t => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-bot-repo-path-entry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const danglingPath = join(dir, 'legacy-prompt.md')
  symlinkSync('missing-target.md', danglingPath)

  assert.equal(hasPathEntry(danglingPath), true)
  assert.equal(hasPathEntry(join(dir, 'absent.md')), false)
})
