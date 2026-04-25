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

describe('Phase 0 agent runtime store contract', () => {
  test('schema has agent-rooted runtime tables and no reply/root compatibility owner', () => {
    const schema = readProjectFile('prisma/schema.prisma')

    for (const model of [
      'model AgentRuntimeSnapshot',
      'model Scene',
      'model RuntimeEvent',
      'model Opportunity',
      'model ActionIntent',
      'model ActionRecord',
      'model MemoryItem',
    ]) {
      assertIncludes(schema, model)
    }

    assertIncludes(schema, '@@unique([agentId])', 'AgentRuntimeSnapshot must be keyed by agentId')
    assertIncludes(schema, '@@unique([agentId, kind, externalId])', 'Scene must map qq_group external ids under agent:main')
    assertIncludes(schema, '@@unique([sceneId, idempotencyKey])', 'RuntimeEvent/Opportunity must dedupe by scene and idempotency')
    assertIncludes(schema, '@@unique([opportunityId, idempotencyKey])', 'ActionIntent must dedupe under an opportunity')
    assertIncludes(schema, '@@unique([idempotencyKey])', 'ActionRecord must be the global delivery idempotency ledger')

    assertExcludes(schema, 'model RootRuntimeSnapshot', 'qq_group roots must not remain as the primary runtime snapshot model')
    assertExcludes(schema, 'model ReplyRecord', 'reply_records must not remain as the delivery/recovery owner')
  })

  test('store layer persists reference-only event and opportunity payloads', () => {
    assert.ok(projectFileExists('src/runtime/agent-runtime-store.ts'), 'missing src/runtime/agent-runtime-store.ts')
    const store = readProjectFile('src/runtime/agent-runtime-store.ts')

    for (const allowed of ['messageRowId', 'messageId', 'ingestSource', 'source', 'idempotencyKey']) {
      assertIncludes(store, allowed)
    }
    for (const forbidden of [
      'segments',
      'plainText',
      'content',
      'rawContent',
      'senderNickname',
      'senderGroupNickname',
      'mediaDescription',
      'mediaDescriptions',
    ]) {
      assertExcludes(store, forbidden, `runtime/opportunity payload must not persist copied user fact: ${forbidden}`)
    }
  })
})
