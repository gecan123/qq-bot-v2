import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createEmptyMailboxContinuityState,
  decideMailboxCompensation,
  isMailboxEngaged,
  MAILBOX_ENGAGEMENT_LEASE_MS,
  MAILBOX_FULL_COMPENSATION_AFTER_ROUNDS,
  MAILBOX_FULL_COMPENSATION_AFTER_TOKENS,
  MAILBOX_FULL_CONTEXT_BEFORE,
  MAILBOX_LIGHT_COMPENSATION_AFTER_MS,
  MAILBOX_LIGHT_CONTEXT_BEFORE,
  parseMailboxContinuityState,
  recordMailboxCompaction,
  recordMailboxDisclosure,
  recordMailboxEngagement,
  recordMailboxRound,
} from './mailbox-continuity.js'

describe('mailbox continuity compensation', () => {
  test('does not compensate a mailbox without a previous disclosure', () => {
    const state = createEmptyMailboxContinuityState()
    const decision = decideMailboxCompensation(state, 'qq_private:9001', Date.now())
    assert.equal(decision.mode, 'none')
    assert.equal(decision.contextBefore, 0)
  })

  test('lightly compensates one prior message after two hours', () => {
    const state = createEmptyMailboxContinuityState()
    recordMailboxDisclosure(state, 'qq_private:9001', 1_000)

    const decision = decideMailboxCompensation(
      state,
      'qq_private:9001',
      1_000 + MAILBOX_LIGHT_COMPENSATION_AFTER_MS,
    )

    assert.equal(decision.mode, 'light')
    assert.equal(decision.contextBefore, MAILBOX_LIGHT_CONTEXT_BEFORE)
  })

  test('fully compensates after thirty durable rounds', () => {
    const state = createEmptyMailboxContinuityState()
    recordMailboxDisclosure(state, 'qq_private:9001', 1_000)
    for (let i = 0; i < MAILBOX_FULL_COMPENSATION_AFTER_ROUNDS; i++) {
      recordMailboxRound(state, 10_000 + i)
    }

    const decision = decideMailboxCompensation(state, 'qq_private:9001', 2_000)

    assert.equal(decision.mode, 'full')
    assert.equal(decision.contextBefore, MAILBOX_FULL_CONTEXT_BEFORE)
    assert.equal(decision.roundsSince, MAILBOX_FULL_COMPENSATION_AFTER_ROUNDS)
  })

  test('fully compensates after context grows by 128k tokens', () => {
    const state = createEmptyMailboxContinuityState()
    recordMailboxRound(state, 20_000)
    recordMailboxDisclosure(state, 'qq_private:9001', 1_000)
    recordMailboxRound(state, 20_000 + MAILBOX_FULL_COMPENSATION_AFTER_TOKENS)

    const decision = decideMailboxCompensation(state, 'qq_private:9001', 2_000)

    assert.equal(decision.mode, 'full')
    assert.equal(decision.tokensSince, MAILBOX_FULL_COMPENSATION_AFTER_TOKENS)
  })

  test('fully compensates once compaction crosses the mailbox anchor', () => {
    const state = createEmptyMailboxContinuityState()
    recordMailboxDisclosure(state, 'qq_group:111', 1_000)
    recordMailboxCompaction(state)

    const decision = decideMailboxCompensation(state, 'qq_group:111', 2_000)

    assert.equal(decision.mode, 'full')
    assert.equal(decision.compactionChanged, true)
    assert.equal(state.lastInputTokens, null)
  })

  test('ignores an older disclosure without replacing the anchor baselines', () => {
    const state = createEmptyMailboxContinuityState()
    recordMailboxRound(state, 1_000)
    recordMailboxDisclosure(state, 'qq_group:111', 10_000)
    const newestAnchor = structuredClone(state.mailboxes['qq_group:111'])

    recordMailboxRound(state, 2_000)
    recordMailboxCompaction(state)
    recordMailboxDisclosure(state, 'qq_group:111', 5_000)

    assert.deepEqual(state.mailboxes['qq_group:111'], newestAnchor)

    recordMailboxDisclosure(state, 'qq_group:111', 10_000)
    assert.deepEqual(state.mailboxes['qq_group:111'], {
      lastMessageAtMs: 10_000,
      roundSeq: 2,
      inputTokens: null,
      compactionEpoch: 1,
    })
  })

  test('tracks several engaged mailboxes independently and expires each lease', () => {
    const state = createEmptyMailboxContinuityState()
    recordMailboxEngagement(state, 'qq:bot:group:111', 1_000)
    recordMailboxEngagement(state, 'qq:bot:group:222', 2_000)

    assert.equal(isMailboxEngaged(state, 'qq:bot:group:111', 1_000 + MAILBOX_ENGAGEMENT_LEASE_MS), true)
    assert.equal(isMailboxEngaged(state, 'qq:bot:group:111', 1_001 + MAILBOX_ENGAGEMENT_LEASE_MS), false)
    assert.equal(isMailboxEngaged(state, 'qq:bot:group:222', 1_001 + MAILBOX_ENGAGEMENT_LEASE_MS), true)
  })

  test('preserves and refreshes engagement when recording a newer disclosure', () => {
    const state = createEmptyMailboxContinuityState()
    recordMailboxEngagement(state, 'qq:bot:group:111', 1_000)
    recordMailboxDisclosure(state, 'qq:bot:group:111', 2_000)
    recordMailboxEngagement(state, 'qq:bot:group:111', 2_000)

    assert.equal(
      state.mailboxes['qq:bot:group:111']?.engagedUntilMs,
      2_000 + MAILBOX_ENGAGEMENT_LEASE_MS,
    )
  })

  test('sanitizes malformed persisted state', () => {
    const state = parseMailboxContinuityState({
      schemaVersion: 99,
      roundSeq: 12,
      lastInputTokens: 1234,
      compactionEpoch: 2,
      mailboxes: {
        'qq_private:9001': {
          lastMessageAtMs: 100,
          roundSeq: 4,
          inputTokens: 900,
          compactionEpoch: 1,
          engagedUntilMs: 2_000,
        },
        invalid: { lastMessageAtMs: 100, roundSeq: 4, inputTokens: 900, compactionEpoch: 1 },
      },
    })

    assert.equal(state.schemaVersion, 2)
    assert.equal(state.roundSeq, 12)
    assert.deepEqual(Object.keys(state.mailboxes), ['qq_private:9001'])
    assert.equal(state.mailboxes['qq_private:9001']?.engagedUntilMs, 2_000)
  })
})
