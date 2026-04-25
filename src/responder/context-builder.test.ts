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

describe('Phase 0 responder context contract', () => {
  test('context is rebuilt from messages plus sent action_records', () => {
    const contextBuilder = readProjectFile('src/responder/context-builder.ts')

    assertIncludes(contextBuilder, 'message', 'messages remain the only inbound user-fact ledger')
    for (const expected of ['actionRecord', 'ActionRecord', 'deliveryState', 'sent']) {
      assertIncludes(contextBuilder, expected)
    }
    for (const forbidden of ['replyRecord', 'ReplyRecord', 'reply_records']) {
      assertExcludes(contextBuilder, forbidden, `context builder must not read reply-only ledger: ${forbidden}`)
    }
  })

  test('context builder does not read dormant memory items', () => {
    const contextBuilder = readProjectFile('src/responder/context-builder.ts')
    assertExcludes(contextBuilder, 'MemoryItem')
    assertExcludes(contextBuilder, 'memoryItems')
  })
})
