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

describe('Phase 0 recovery contract', () => {
  test('startup recovery is based on action_records and never reply_records', () => {
    const recovery = readProjectFile('src/conversation/recovery.ts')

    for (const expected of ['actionRecord', 'ActionRecord', 'deliveryState']) {
      assertIncludes(recovery, expected)
    }
    for (const forbidden of ['replyRecord', 'ReplyRecord', 'reply_records']) {
      assertExcludes(recovery, forbidden, `recovery must not depend on reply-only ledger: ${forbidden}`)
    }
  })

  test('recovery covers retryable delivery states', () => {
    const recovery = readProjectFile('src/conversation/recovery.ts')
    for (const state of ['pending', 'sending', 'failed', 'acked']) {
      assertIncludes(recovery, state, `recovery must make ${state} action_records explicit`)
    }
  })
})
