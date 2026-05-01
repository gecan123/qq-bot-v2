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
const countIncludes = (content: string, needle: string): number => content.split(needle).length - 1

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

  test('Phase 5 memory items are only created through proposal governance', () => {
    const schema = readProjectFile('prisma/schema.prisma')
    const generationAndSql = ['src/runtime/root-runtime.ts', 'src/responder/reply-generator.ts', 'src/agent/tools.ts', 'src/database/agent-sql.ts']
      .filter(projectFileExists)
      .map(readProjectFile)
      .join('\n')
    const store = readProjectFile('src/runtime/agent-runtime-store.ts')

    assertIncludes(schema, 'model MemoryItem')
    assertIncludes(schema, 'model MemoryProposal')
    for (const token of ['memoryType', 'sourceProposalId', 'sourceRef', 'confidence', 'salience', 'expiresAt', 'decayPolicy']) {
      assertIncludes(schema, token)
    }
    assertIncludes(store, 'reviewMemoryProposal')
    assertIncludes(store, 'autoAcceptMemoryProposalIfAllowed')
    assertExcludes(generationAndSql, 'write_memory', 'reply generation must not register a direct write_memory action')
    assertExcludes(generationAndSql, 'memoryItems', 'reply generation/SQL/runtime must not read MemoryItem rows as a side effect')
    assertExcludes(generationAndSql, 'memoryItem', 'reply generation/SQL/runtime must not write MemoryItem rows directly')
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
      "'create_memory_proposal'",
      "'update_self_spine'",
      "'proposed' | 'rejected' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'skipped'",
      "'internal'",
      "'persistence'",
      "'private_reply'",
      "'anchored_group_reply'",
      "'ambient_group_post'",
      "'public_post'",
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

  test('root runtime durable surfaces are reference-only and execution goes through arbiter candidates', () => {
    const rootRuntime = readProjectFile('src/runtime/root-runtime.ts')

    assertIncludes(rootRuntime, "'qq_group_message_received'")
    assertIncludes(rootRuntime, 'createOrReuseDecision')
    assertIncludes(rootRuntime, 'buildArbiterCandidates')
    assertIncludes(rootRuntime, 'acceptArbiterProposal')
    assertIncludes(rootRuntime, 'chooseDeterministicCandidate')
    assertIncludes(rootRuntime, 'arbitrateAndExecute')
    assertIncludes(rootRuntime, "'scheduler_tick'")
    assertIncludes(rootRuntime, "'manual_wake'")
    assertIncludes(rootRuntime, 'const pendingOpportunities = await listPendingArbiterOpportunities({ limit: 50 })')
    assertIncludes(rootRuntime, 'const arbiterOpportunities = pendingOpportunities.some')
    assertIncludes(rootRuntime, "contextSnapshot: { messages: [] }")
    assertExcludes(rootRuntime, 'segmentsToPlainText')
    assertExcludes(rootRuntime, 'content: text')
    assertExcludes(rootRuntime, 'senderNickname:')
  })

  test('opportunity status follows executor delivery result instead of assuming success', () => {
    const rootRuntime = readProjectFile('src/runtime/root-runtime.ts')
    const passiveProcessor = readProjectFile('src/runtime/passive-mention-processor.ts')

    assertIncludes(rootRuntime, 'opportunityStatusFromDeliveryResult(result.deliveryResult)')
    assertIncludes(rootRuntime, "case 'sent':")
    assertIncludes(rootRuntime, "case 'failed':")
    assertIncludes(rootRuntime, 'opportunityStatusFromPassiveResult(result)')
    assertIncludes(passiveProcessor, 'deliveryResults.push(result.deliveryResult ??')
  })

  test('pending arbiter query samples each queue before candidate sorting', () => {
    const store = readProjectFile('src/runtime/agent-runtime-store.ts')

    assertIncludes(store, "const ARBITER_QUEUE_KINDS: readonly QueueKind[] = ['obligation', 'social', 'curiosity', 'maintenance']")
    assertIncludes(store, 'Promise.all(ARBITER_QUEUE_KINDS.map')
    assertIncludes(store, 'queueKind,')
    assertIncludes(store, 'take: perQueueLimit')
  })

  test('Phase 7/8 migration keeps ambient group post distinct from anchored group reply', () => {
    const migration = readProjectFile('prisma/migrations/20260426131854_runtime_phase7_8_arbiter_barrier/migration.sql')

    assertIncludes(migration, `"action_type" = 'send_group_message' THEN 'ambient_group_post'`)
    assertIncludes(migration, `"action_type" IN ('reply_to_message', 'send_group_reply') THEN 'anchored_group_reply'`)
    assertIncludes(migration, `"barrier_input"->>'actionType' = 'send_group_message' THEN 'ambient_group_post'`)
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
      "'private_reply'",
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
    assert.ok(
      countIncludes(forumExecutor, 'barrierVerdict: barrierOutput') >= 2,
      'forum read ActionRecord must keep barrier verdict from creation through completion',
    )
  })

  test('Phase 6 Self Spine is versioned and not directly mutated by single source events', () => {
    const schema = readProjectFile('prisma/schema.prisma')
    const store = readProjectFile('src/runtime/agent-runtime-store.ts')
    const rootRuntime = readProjectFile('src/runtime/root-runtime.ts')
    const forumExecutor = readProjectFile('src/curiosity/forum-read-executor.ts')

    for (const token of [
      'model SelfSpineUpdateProposal',
      'model SelfSpineVersion',
      'sourceRef',
      'patch',
      'version',
      'snapshot',
      'diff',
      'rollbackOfVersion',
      '@unique @map("source_proposal_id")',
    ]) {
      assertIncludes(schema, token)
    }
    for (const token of [
      'createOrReuseSelfSpineUpdateProposal',
      'reviewSelfSpineUpdateProposal',
      'rollbackSelfSpineVersion',
      'assertSelfSpineSourceCanMutate',
      'single_message',
      'single_forum_post',
    ]) {
      assertIncludes(store, token)
    }
    assertExcludes(rootRuntime, 'selfSpineVersion')
    assertExcludes(rootRuntime, 'reviewSelfSpineUpdateProposal')
    assertExcludes(forumExecutor, 'reviewSelfSpineUpdateProposal')
  })

  test('durable social barrier records dry-run when reply dry-run is enabled', () => {
    const rootRuntime = readProjectFile('src/runtime/root-runtime.ts')
    const index = readProjectFile('src/index.ts')

    assertIncludes(rootRuntime, 'replyDryRunEnabled?: boolean')
    assertIncludes(rootRuntime, 'const replyDryRunEnabled = options.replyDryRunEnabled === true')
    assertIncludes(rootRuntime, 'decideExecution')
    assertIncludes(rootRuntime, 'riskBand')
    assertIncludes(rootRuntime, 'effectMode')
    assertIncludes(rootRuntime, 'allowedToSend')
    assertIncludes(rootRuntime, 'dispatchMode: barrierVerdict.effectMode')
    assertIncludes(rootRuntime, "sideEffect: allowedToSend ? 'napcat_send' : dryRun ? 'audit_write' : 'none'")
    assertIncludes(rootRuntime, 'privateReplyDryRun: replyDryRunEnabled')
    assertIncludes(index, 'replyDryRunEnabled: messageSender.isReplyDryRunEnabled?.() ?? config.botReplyDryRun')
  })

  test('Phase 1.5 后: 群消息只在 mention 时进 runtime 链路, 不再生成 proactive_candidate opportunity', () => {
    const rootRuntime = readProjectFile('src/runtime/root-runtime.ts')

    // 砍 proactive judge / ambient candidate 之后, root-runtime 不应再引用这些
    assertExcludes(rootRuntime, 'proactiveJudge', 'proactive judge integration was removed')
    assertExcludes(rootRuntime, 'buildAmbientReplyOpportunity', 'ambient reply opportunity factory was removed')
    assertExcludes(rootRuntime, 'buildAmbientJudgeAdvice', 'ambient judge advice helper was removed')
    // 普通群消息进入 runtime 时只 ingest 和写 RuntimeEvent, 不再生成 opportunity
    assertIncludes(rootRuntime, "if (!isPrivate && !mentioned)")
  })
})
