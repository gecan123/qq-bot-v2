import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { classifyAction, decideExecution, DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG } from './action-barrier.js'

describe('minimal action barrier', () => {
  test('classifies actions into behavior semantic risk bands', () => {
    assert.equal(classifyAction({ actionType: 'artifact_only' }), 'persistence')
    assert.equal(classifyAction({ actionType: 'send_private_message' }), 'private_reply')
    assert.equal(classifyAction({ actionType: 'reply_to_message' }), 'anchored_group_reply')
    assert.equal(classifyAction({ actionType: 'send_group_reply' }), 'anchored_group_reply')
    // Phase 0: send_group_message 暂时复用 anchored_group_reply 的 riskBand,
    // 区分由 actionType 在 decideExecution 中处理。
    assert.equal(classifyAction({ actionType: 'send_group_message' }), 'anchored_group_reply')
    assert.equal(classifyAction({ actionType: 'internal' }), 'internal')
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

  test('requires review for direct Self Spine mutation', () => {
    const verdict = decideExecution({ actionType: 'update_self_spine', executorAvailable: true })

    assert.equal(verdict.riskBand, 'persistence')
    assert.equal(verdict.effectMode, 'requires_review')
    assert.equal(verdict.allowedByPolicy, false)
  })

  test('Phase 0: send_group_message default-suppresses live execution', () => {
    // DEFAULT config: allowSendGroupMessageLive = false
    const verdict = decideExecution(
      { actionType: 'send_group_message', executorAvailable: true },
      {},
      DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG,
    )

    assert.equal(verdict.riskBand, 'anchored_group_reply')
    assert.equal(verdict.effectMode, 'suppressed')
    assert.equal(verdict.allowedByPolicy, false)
    assert.match(verdict.reason, /Phase 10 gate/)
  })

  test('Phase 0: send_group_message with allowSendGroupMessageLive=true and no dry-run goes live', () => {
    const verdict = decideExecution(
      { actionType: 'send_group_message', executorAvailable: true },
      {},
      { ...DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG, allowSendGroupMessageLive: true },
    )

    assert.equal(verdict.effectMode, 'live')
    assert.equal(verdict.allowedByPolicy, true)
  })

  test('Phase 0: send_group_message with allowSendGroupMessageLive=true and dry-run flag goes dry_run', () => {
    const verdict = decideExecution(
      { actionType: 'send_group_message', executorAvailable: true, dryRunRequested: true },
      {},
      { ...DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG, allowSendGroupMessageLive: true },
    )

    assert.equal(verdict.effectMode, 'dry_run')
    assert.equal(verdict.allowedByPolicy, false)
  })

  test('Phase 0: send_group_message remains suppressed when executor missing', () => {
    const verdict = decideExecution(
      { actionType: 'send_group_message', executorAvailable: false },
      {},
      { ...DEFAULT_ACTION_BARRIER_RUNTIME_CONFIG, allowSendGroupMessageLive: true },
    )

    assert.equal(verdict.effectMode, 'suppressed')
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
