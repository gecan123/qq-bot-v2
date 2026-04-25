import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const readProjectFile = (relativePath: string): string =>
  readFileSync(resolve(projectRoot, relativePath), 'utf8')
const projectFileExists = (relativePath: string): boolean => existsSync(resolve(projectRoot, relativePath))
const assertIncludes = (content: string, needle: string, message?: string): void => {
  assert.ok(content.includes(needle), message ?? `expected file to include ${needle}`)
}
const assertExcludes = (content: string, needle: string, message?: string): void => {
  assert.ok(!content.includes(needle), message ?? `expected file not to include ${needle}`)
}

describe('Phase 0 action executor contract', () => {
  test('delivery writes ActionRecord, not reply_records', () => {
    assert.ok(projectFileExists('src/runtime/action-executor.ts'), 'missing src/runtime/action-executor.ts')
    const executor = readProjectFile('src/runtime/action-executor.ts')

    for (const expected of ['ActionIntent', 'ActionRecord', 'reply_to_message', 'send_group_message', 'deliveryState', 'idempotencyKey']) {
      assertIncludes(executor, expected)
    }
    for (const forbidden of ['replyRecord', 'ReplyRecord', 'reply_records']) {
      assertExcludes(executor, forbidden, `action executor must not use reply-only ledger: ${forbidden}`)
    }
  })

  test('ambient/proactive candidates stay artifact-only or dry-run', () => {
    const executor = projectFileExists('src/runtime/action-executor.ts') ? readProjectFile('src/runtime/action-executor.ts') : ''
    assertIncludes(executor, 'ambient_candidate')
    assertIncludes(executor, 'dryRun')
    assertExcludes(executor, "ambient_candidate' &&", 'ambient live-send policy should be explicit, not a fallthrough')
  })
})
