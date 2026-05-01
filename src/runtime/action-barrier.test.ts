import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { classifyAction, decideExecution, DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG } from './action-barrier.js'

describe('minimal action barrier', () => {
  test('classifies actions into behavior semantic risk bands', () => {
    assert.equal(classifyAction({ actionType: 'artifact_only' }), 'persistence')
    assert.equal(classifyAction({ actionType: 'send_private_message' }), 'private_reply')
    assert.equal(classifyAction({ actionType: 'reply_to_message' }), 'anchored_group_reply')
    assert.equal(classifyAction({ actionType: 'send_group_message' }), 'ambient_group_post')
    assert.equal(classifyAction({ actionType: 'public_post' }), 'public_post')
  })

  test('allows anchored group replies and private replies live when dry-run is off', () => {
    const mention = decideExecution({ actionType: 'reply_to_message', executorAvailable: true })
    const privateReply = decideExecution({ actionType: 'send_private_message', executorAvailable: true })

    assert.equal(mention.riskBand, 'anchored_group_reply')
    assert.equal(mention.effectMode, 'live')
    assert.equal(mention.allowedByPolicy, true)
    assert.equal(privateReply.riskBand, 'private_reply')
    assert.equal(privateReply.effectMode, 'live')
    assert.equal(privateReply.allowedByPolicy, true)
  })

  test('keeps ambient group posts dry-run before proactive live-send canary', () => {
    const verdict = decideExecution({
      actionType: 'send_group_message',
      executorAvailable: true,
      dryRunRequested: false,
    })

    assert.equal(verdict.riskBand, 'ambient_group_post')
    assert.equal(verdict.effectMode, 'dry_run')
    assert.equal(verdict.allowedByPolicy, false)
  })

  test('requires review for direct Self Spine mutation', () => {
    const verdict = decideExecution({ actionType: 'update_self_spine', executorAvailable: true })

    assert.equal(verdict.riskBand, 'persistence')
    assert.equal(verdict.effectMode, 'requires_review')
    assert.equal(verdict.allowedByPolicy, false)
  })

  test('blocks public post by default', () => {
    const verdict = decideExecution({ actionType: 'public_post', executorAvailable: true })

    assert.equal(verdict.riskBand, 'public_post')
    assert.equal(verdict.effectMode, 'blocked')
    assert.equal(verdict.allowedByPolicy, false)
  })
})

// ActionExecutor always recomputes the barrier from (actionType, targetSceneId, dryRun, executorAvailable)
// using DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG. root-runtime adds privateReplyDryRun/anchoredGroupReplyDryRun
// but encodes the same decision into intent.dryRun before dispatch, so both paths must agree.
describe('barrier verdict consistency: DEFAULT config + intent.dryRun == root-runtime config + replyDryRunEnabled', () => {
  const rootRuntimeConfig = (replyDryRunEnabled: boolean) => ({
    ...DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
    privateReplyDryRun: replyDryRunEnabled,
    anchoredGroupReplyDryRun: replyDryRunEnabled,
  })

  for (const replyDryRunEnabled of [false, true]) {
    const label = replyDryRunEnabled ? 'dry-run enabled' : 'dry-run disabled'

    test(`private_reply effectMode agrees when ${label}`, () => {
      const rootVerdict = decideExecution(
        { actionType: 'send_private_message', dryRunRequested: replyDryRunEnabled, executorAvailable: true },
        {},
        rootRuntimeConfig(replyDryRunEnabled),
      )
      const executorVerdict = decideExecution(
        { actionType: 'send_private_message', dryRunRequested: replyDryRunEnabled, executorAvailable: true },
        {},
        DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
      )
      assert.equal(executorVerdict.effectMode, rootVerdict.effectMode)
    })

    test(`anchored_group_reply effectMode agrees when ${label}`, () => {
      const rootVerdict = decideExecution(
        { actionType: 'send_group_reply', dryRunRequested: replyDryRunEnabled, executorAvailable: true },
        {},
        rootRuntimeConfig(replyDryRunEnabled),
      )
      const executorVerdict = decideExecution(
        { actionType: 'send_group_reply', dryRunRequested: replyDryRunEnabled, executorAvailable: true },
        {},
        DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
      )
      assert.equal(executorVerdict.effectMode, rootVerdict.effectMode)
    })
  }
})
