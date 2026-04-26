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

describe('Runtime OS contract', () => {
  test('agent:main is the only root and qq_group is only a scene identity', () => {
    assert.ok(projectFileExists('src/runtime/agent-runtime-types.ts'), 'missing src/runtime/agent-runtime-types.ts')
    const contracts = readProjectFile('src/runtime/agent-runtime-types.ts')
    const rootRuntime = projectFileExists('src/runtime/root-runtime.ts') ? readProjectFile('src/runtime/root-runtime.ts') : ''
    const legacyTypes = projectFileExists('src/runtime/types.ts') ? readProjectFile('src/runtime/types.ts') : ''

    assertIncludes(contracts, 'MAIN_AGENT_ID')
    assertIncludes(contracts, 'agent:main')
    assertIncludes(contracts, 'Scene')
    assertIncludes(contracts, 'qq_group')

    assertExcludes(`${contracts}
${rootRuntime}
${legacyTypes}`, 'makeGroupRuntimeKey', 'qq_group:* must not be constructible as a root runtime key')
    assertExcludes(`${contracts}
${rootRuntime}
${legacyTypes}`, 'runtimeKey: `qq_group:', 'qq_group:* must not be stored as root runtimeKey')
    assertExcludes(`${contracts}
${rootRuntime}`, 'runtimeKey: `qq_group:', 'root runtime snapshot must not carry qq_group runtime keys')
  })

  test('memory is represented only as dormant contract in Phase 0', () => {
    const schema = readProjectFile('prisma/schema.prisma')
    const allRuntime = ['src/runtime/agent-runtime-types.ts', 'src/runtime/root-runtime.ts', 'src/responder/reply-generator.ts', 'src/agent/tools.ts', 'src/database/agent-sql.ts']
      .filter(projectFileExists)
      .map(readProjectFile)
      .join('\n')

    assertIncludes(schema, 'model MemoryItem')
    assertIncludes(schema, 'model MemoryProposal')
    assertExcludes(allRuntime, 'write_memory', 'Phase 0 must not register a write_memory action')
    assertExcludes(allRuntime, 'memoryItems', 'Phase 0 generation/SQL/runtime must not read MemoryItem rows')
    assertExcludes(allRuntime, 'MemoryItem', 'MemoryItem must remain dormant outside schema/type declarations')
  })

  test('Phase 1 contract covers runtime OS surfaces and lifecycle', () => {
    const contracts = readProjectFile('src/runtime/agent-runtime-types.ts')
    const schema = readProjectFile('prisma/schema.prisma')

    for (const token of [
      'qq_group_message_received',
      'qq_private_message_received',
      'forum_item_seen',
      'news_item_seen',
      'task_due',
      'memory_maintenance_due',
      'self_spine_review_due',
      "'curiosity'",
      "'proactive_candidate'",
      "'create_memory_proposal'",
      "'update_self_spine'",
      "'proposed' | 'rejected' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'skipped'",
      "'L0' | 'L1' | 'L2' | 'L3' | 'L4'",
    ]) {
      assertIncludes(contracts, token)
    }

    for (const token of [
      'model Decision',
      'decisionId',
      'policyVersion',
      'verdict',
      'riskLevel',
      'barrierInput',
      'barrierOutput',
      'model MemoryProposal',
    ]) {
      assertIncludes(schema, token)
    }
  })

  test('root runtime durable surfaces are reference-only and ambient uses executor policy', () => {
    const rootRuntime = readProjectFile('src/runtime/root-runtime.ts')

    assertIncludes(rootRuntime, "'qq_group_message_received'")
    assertIncludes(rootRuntime, 'createOrReuseDecision')
    assertIncludes(rootRuntime, 'ambientExecutor.execute')
    assertIncludes(rootRuntime, "contextSnapshot: { messages: [] }")
    assertExcludes(rootRuntime, 'segmentsToPlainText')
    assertExcludes(rootRuntime, 'content: text')
    assertExcludes(rootRuntime, 'senderNickname:')
  })

  test('Phase 3 private scene shares runtime/action path without a private ledger', () => {
    const rootRuntime = readProjectFile('src/runtime/root-runtime.ts')
    const schema = readProjectFile('prisma/schema.prisma')
    const core = readProjectFile('src/bot/core.ts')
    const executor = readProjectFile('src/runtime/reply-executor.ts')

    for (const token of [
      "'private_message'",
      "'qq_private_message_received'",
      "'reply_private_message'",
      "'send_private_message'",
      "'L2'",
      'ambientExecutor.execute(buildPrivateReplyOpportunity',
    ]) {
      assertIncludes(rootRuntime, token)
    }
    assertIncludes(core, "napcat.on('message.private'")
    assertIncludes(core, "sceneKind: 'qq_private'")
    assertIncludes(schema, 'sceneKind')
    assertIncludes(schema, 'sceneExternalId')
    assertIncludes(schema, '@@unique([sceneKind, sceneExternalId, messageId])')
    assertIncludes(executor, 'sendPrivateMessage')
    assertExcludes(schema, 'model PrivateMessage')
  })

  test('Phase 4 forum curiosity path is read-only and does not use message sender', () => {
    const schema = readProjectFile('prisma/schema.prisma')
    const forumExecutor = readProjectFile('src/curiosity/forum-read-executor.ts')

    for (const token of [
      'model FeedSource',
      'model FeedItem',
      'model ReadSession',
      'model SourceSummary',
      'model ThoughtArtifact',
      'model RationaleArtifact',
    ]) {
      assertIncludes(schema, token)
    }

    for (const token of [
      "'forum_item_seen'",
      "'read_forum_post'",
      "'curiosity'",
      'forbiddenActions',
      'reply',
      'comment',
      'like',
      'public_outbound',
    ]) {
      assertIncludes(forumExecutor, token)
    }

    assertExcludes(forumExecutor, 'MessageSender')
    assertExcludes(forumExecutor, 'sendMessage(')
    assertExcludes(forumExecutor, 'sendPrivateMessage')
    assertExcludes(forumExecutor, 'send_group_msg')
    assertExcludes(forumExecutor, 'send_private_msg')
    assertExcludes(forumExecutor, 'createOrReuseMemoryProposal')
    assertExcludes(forumExecutor, 'memoryProposalId')
  })

  test('durable social barrier records dry-run when reply dry-run is enabled', () => {
    const rootRuntime = readProjectFile('src/runtime/root-runtime.ts')
    const index = readProjectFile('src/index.ts')

    assertIncludes(rootRuntime, 'replyDryRunEnabled?: boolean')
    assertIncludes(rootRuntime, 'const replyDryRunEnabled = options.replyDryRunEnabled === true')
    assertIncludes(rootRuntime, "verdict: barrierVerdict")
    assertIncludes(rootRuntime, 'allowedToSend')
    assertIncludes(rootRuntime, "dispatchMode: allowedToSend ? 'live' : dryRun ? 'dry_run' : 'skipped'")
    assertIncludes(rootRuntime, "sideEffect: allowedToSend ? 'napcat_send' : dryRun ? 'audit_write' : 'none'")
    assertIncludes(rootRuntime, 'dryRun: replyDryRunEnabled')
    assertIncludes(index, 'replyDryRunEnabled: messageSender.isReplyDryRunEnabled?.() ?? config.botReplyDryRun')
  })
})
