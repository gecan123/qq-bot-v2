import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildProactiveCandidateMetrics,
  collectProactiveCandidateMetrics,
  formatProactiveCandidateMetricsMarkdown,
  normalizeProactiveCandidateAudit,
  type MessageMetricRow,
  type ReplyAuditMetricRow,
} from './proactive-candidate-metrics.js'
import { parseProactiveCandidateReportArgs } from './proactive-candidate-report-cli.js'

function audit(overrides: Partial<ReplyAuditMetricRow> = {}): ReplyAuditMetricRow {
  return {
    id: 1,
    groupId: 100n,
    opportunityId: 'qq_group:100:message:10:send_message',
    runtimeKey: 'qq_group:100',
    scopeKey: 'qq_group:100',
    replyIntentId: 'qq_group:100:message:10:send_message',
    auditKind: 'proactive_candidate',
    payload: {
      artifactKind: 'proactive_candidate',
      status: 'candidate_generated',
      triggerMessageRowId: 10,
      incorporatedMessageRowId: 10,
      sourceKind: 'ambient_message',
      score: 0.8,
      gateReasons: [],
      policyReasons: [],
      candidateText: '这个可以接一句',
      termination: 'final_answer',
      tokenUsageState: 'captured',
      tokenUsage: {
        total: { promptTokens: 10, completionTokens: 3, totalTokens: 13, calls: 1 },
        byOperation: {
          agent: { promptTokens: 10, completionTokens: 3, totalTokens: 13, calls: 1 },
        },
      },
    },
    createdAt: new Date('2026-04-25T01:00:00.000Z'),
    ...overrides,
  }
}

function message(overrides: Partial<MessageMetricRow> = {}): MessageMetricRow {
  return {
    id: 10,
    groupId: 100n,
    messageId: 9001n,
    senderId: 42n,
    senderNickname: 'sender',
    senderGroupNickname: 'group sender',
    content: [{ type: 'text', content: '群里刚刚说的内容' }],
    searchText: '群里刚刚说的内容',
    resolvedText: null,
    createdAt: new Date('2026-04-25T00:59:00.000Z'),
    ...overrides,
  }
}

describe('proactive candidate audit normalization', () => {
  test('normalizes generated candidate with captured token usage and message types', () => {
    const observation = normalizeProactiveCandidateAudit(audit(), new Map([[10, message()]]))

    assert.equal(observation.normalizedStatus, 'candidate_generated')
    assert.equal(observation.tokenUsageState, 'captured')
    assert.equal(observation.tokenUsage?.total.totalTokens, 13)
    assert.equal(observation.messageTypeCompleteness, 'captured')
    assert.equal(observation.primaryMessageType, 'text')
    assert.deepEqual(observation.segmentTypes, ['text'])
    assert.equal(observation.triggerTextPreview, '群里刚刚说的内容')
  })

  test('keeps old suppressed rows out of captured message-type stats', () => {
    const observation = normalizeProactiveCandidateAudit(audit({
      id: 2,
      opportunityId: 'legacy-opportunity',
      payload: {
        outcome: 'opportunity_detected',
        sourceKind: 'ambient_message',
        gateReasons: ['active_chat'],
      },
    }))

    assert.equal(observation.artifactStatus, 'suppressed')
    assert.equal(observation.normalizedStatus, 'gate_suppressed')
    assert.equal(observation.tokenUsageState, 'not_applicable')
    assert.equal(observation.messageTypeCompleteness, 'unknown')
    assert.equal(observation.primaryMessageType, 'unknown')
  })

  test('marks opportunity-id message row hints as inferred, not captured', () => {
    const observation = normalizeProactiveCandidateAudit(audit({
      id: 3,
      payload: {
        gateReasons: ['cooldown'],
      },
    }), new Map([[10, message({
      content: [{ type: 'image', fileName: 'meme.png' }],
      searchText: '[图片]',
    })]]))

    assert.equal(observation.normalizedStatus, 'gate_suppressed')
    assert.equal(observation.messageTypeCompleteness, 'inferred_from_opportunity_id')
    assert.equal(observation.primaryMessageType, 'image')
  })

  test('trusts explicit not_applicable token state on no_candidate payloads', () => {
    const observation = normalizeProactiveCandidateAudit(audit({
      id: 4,
      payload: {
        artifactKind: 'proactive_candidate',
        status: 'no_candidate',
        triggerMessageRowId: 10,
        incorporatedMessageRowId: 10,
        sourceKind: 'ambient_message',
        score: 0.8,
        gateReasons: [],
        policyReasons: [],
        termination: 'missing_incoming_message',
        tokenUsageState: 'not_applicable',
      },
    }), new Map([[10, message()]]))

    assert.equal(observation.normalizedStatus, 'no_candidate')
    assert.equal(observation.tokenUsageState, 'not_applicable')
  })
})

describe('proactive candidate metrics aggregation', () => {
  test('aggregates daily status, reason, token, quality, and review queue metrics', () => {
    const observations = [
      normalizeProactiveCandidateAudit(audit(), new Map([[10, message()]])),
      normalizeProactiveCandidateAudit(audit({
        id: 2,
        payload: {
          status: 'no_candidate',
          triggerMessageRowId: 11,
          incorporatedMessageRowId: 11,
          sourceKind: 'ambient_message',
          gateReasons: [],
          policyReasons: [],
          termination: 'implicit_text_disallowed',
        },
      }), new Map([[11, message({ id: 11, content: [{ type: 'record', fileName: 'voice.amr' }] })]])),
      normalizeProactiveCandidateAudit(audit({
        id: 3,
        groupId: 200n,
        createdAt: new Date('2026-04-26T01:00:00.000Z'),
        payload: {
          status: 'suppressed',
          triggerMessageRowId: 12,
          incorporatedMessageRowId: 12,
          gateReasons: ['active_chat'],
          policyReasons: [],
        },
      }), new Map([[12, message({ id: 12, groupId: 200n })]])),
    ]

    const metrics = buildProactiveCandidateMetrics(observations, {
      from: new Date('2026-04-25T00:00:00.000Z'),
      to: new Date('2026-04-27T00:00:00.000Z'),
      reviewLimit: 10,
    })

    assert.deepEqual(metrics.dailyByGroup.map((row) => [row.date, row.groupId, row.totalAudits]), [
      ['2026-04-25', 100, 2],
      ['2026-04-26', 200, 1],
    ])
    assert.equal(metrics.dailyByGroup[0]?.candidateGenerated, 1)
    assert.equal(metrics.dailyByGroup[0]?.noCandidate, 1)
    assert.equal(metrics.dailyByGroup[1]?.gateSuppressed, 1)
    assert.equal(metrics.tokenUsage.captured, 1)
    assert.equal(metrics.tokenUsage.unknown, 1)
    assert.equal(metrics.tokenUsage.notApplicable, 1)
    assert.equal(metrics.gateBreakdown.find((row) => row.reason === 'active_chat')?.count, 1)
    assert.equal(metrics.reviewQueue.length, 1)
    assert.equal(metrics.reviewQueue[0]?.candidateText, '这个可以接一句')
  })

  test('collects from reply_audits and joins messages by row id', async () => {
    const calls: string[] = []
    const metrics = await collectProactiveCandidateMetrics({
      from: new Date('2026-04-25T00:00:00.000Z'),
      to: new Date('2026-04-26T00:00:00.000Z'),
      groupId: 100,
      reviewLimit: 5,
    }, {
      replyAudit: {
        findMany: async (args) => {
          calls.push(`audit:${args.where.auditKind}:${String(args.where.groupId)}`)
          return [audit()]
        },
      },
      message: {
        findMany: async (args) => {
          calls.push(`message:${args.where.id.in.join(',')}`)
          return [message()]
        },
      },
    })

    assert.deepEqual(calls, ['audit:proactive_candidate:100', 'message:10'])
    assert.equal(metrics.dailyByGroup[0]?.candidateGenerated, 1)
    assert.equal(metrics.reviewQueue[0]?.messageTypeCompleteness, 'captured')
  })

  test('formats markdown with required report sections', () => {
    const metrics = buildProactiveCandidateMetrics([
      normalizeProactiveCandidateAudit(audit(), new Map([[10, message()]])),
    ], {
      from: new Date('2026-04-25T00:00:00.000Z'),
      to: new Date('2026-04-26T00:00:00.000Z'),
      reviewLimit: 5,
    })

    const markdown = formatProactiveCandidateMetricsMarkdown(metrics)
    assert.match(markdown, /Daily By Group/)
    assert.match(markdown, /Message Type Breakdown/)
    assert.match(markdown, /Review Queue/)
    assert.match(markdown, /这个可以接一句/)
  })
})

describe('proactive candidate report CLI args', () => {
  test('parses date window, group, format, and limit', () => {
    const options = parseProactiveCandidateReportArgs([
      '--',
      '--from',
      '2026-04-25',
      '--to=2026-04-26',
      '--group',
      '100',
      '--format=json',
      '--limit',
      '3',
    ])

    assert.equal(options.from.toISOString(), '2026-04-25T00:00:00.000Z')
    assert.equal(options.to.toISOString(), '2026-04-27T00:00:00.000Z')
    assert.equal(options.groupId, 100)
    assert.equal(options.format, 'json')
    assert.equal(options.limit, 3)
  })
})
