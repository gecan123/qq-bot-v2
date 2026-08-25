export type ToolContinuationPolicy = 'immediate' | 'wait_attention' | 'wait_event' | 'backoff' | 'stop'

export interface LoopPolicyInput {
  ranRound: boolean
  stopRequested: boolean
  toolCallCount: number
  actionRequired: boolean
  recoverableToolFailure: boolean
  onlyHelpToolCalls: boolean
  madeToolProgress: boolean
  toolContinuation?: ToolContinuationPolicy
  correctionRetryPending: boolean
  recoverableCorrectionRounds: number
  maxRecoverableCorrectionRounds: number
}

export type LoopPolicyDecision =
  | { action: 'wait_event'; reason: 'no_actionable_context'; recoverableCorrectionRounds: number }
  | { action: 'stop'; recoverableCorrectionRounds: number }
  | {
      action: 'continue'
      reason:
        | 'recoverable_tool_correction'
        | 'tool_immediate'
        | 'tool_progress'
        | 'action_correction'
        | 'tool_external_started'
        | 'tool_direction_complete'
        | 'tool_no_progress'
        | 'seek_next_action'
      correctionRetryPending: boolean
      recoverableCorrectionRounds: number
    }
  | {
      action: 'wait_attention'
      reason: 'tool_backoff' | 'action_correction'
      timeout: 'action_retry'
      recoverableCorrectionRounds: number
    }

export function decideLoopPolicy(input: LoopPolicyInput): LoopPolicyDecision {
  if (!input.ranRound) {
    return input.stopRequested
      ? { action: 'stop', recoverableCorrectionRounds: input.recoverableCorrectionRounds }
      : { action: 'wait_event', reason: 'no_actionable_context', recoverableCorrectionRounds: input.recoverableCorrectionRounds }
  }
  if (input.stopRequested) return { action: 'stop', recoverableCorrectionRounds: input.recoverableCorrectionRounds }

  let correctionRounds = input.recoverableCorrectionRounds
  if (input.toolCallCount > 0) {
    const continuingCorrection = input.recoverableToolFailure
      || (correctionRounds > 0 && input.onlyHelpToolCalls)
    if (continuingCorrection && correctionRounds < input.maxRecoverableCorrectionRounds) {
      return {
        action: 'continue', reason: 'recoverable_tool_correction', correctionRetryPending: false,
        recoverableCorrectionRounds: correctionRounds + 1,
      }
    }
    if (!input.recoverableToolFailure && !input.onlyHelpToolCalls) correctionRounds = 0
    if (input.toolContinuation === 'immediate') {
      return { action: 'continue', reason: 'tool_immediate', correctionRetryPending: false, recoverableCorrectionRounds: correctionRounds }
    }
    if (input.toolContinuation === 'wait_event') {
      return { action: 'continue', reason: 'tool_external_started', correctionRetryPending: false, recoverableCorrectionRounds: 0 }
    }
    if (input.toolContinuation === 'stop' || input.toolContinuation === 'wait_attention') {
      return { action: 'continue', reason: 'tool_direction_complete', correctionRetryPending: false, recoverableCorrectionRounds: correctionRounds }
    }
    if (input.toolContinuation === 'backoff') {
      return {
        action: 'wait_attention', reason: 'tool_backoff',
        timeout: 'action_retry',
        recoverableCorrectionRounds: correctionRounds,
      }
    }
    if (input.madeToolProgress) {
      return { action: 'continue', reason: 'tool_progress', correctionRetryPending: false, recoverableCorrectionRounds: correctionRounds }
    }
    if (input.actionRequired && !input.correctionRetryPending) {
      return { action: 'continue', reason: 'action_correction', correctionRetryPending: true, recoverableCorrectionRounds: correctionRounds }
    }
    if (input.actionRequired) {
      return {
        action: 'wait_attention', reason: 'action_correction', timeout: 'action_retry',
        recoverableCorrectionRounds: correctionRounds,
      }
    }
    return {
      action: 'continue', reason: 'tool_no_progress', correctionRetryPending: false,
      recoverableCorrectionRounds: correctionRounds,
    }
  }

  if (input.actionRequired || input.correctionRetryPending) {
    if (!input.correctionRetryPending) {
      return { action: 'continue', reason: 'action_correction', correctionRetryPending: true, recoverableCorrectionRounds: correctionRounds }
    }
    return { action: 'wait_attention', reason: 'action_correction', timeout: 'action_retry', recoverableCorrectionRounds: correctionRounds }
  }
  return { action: 'continue', reason: 'seek_next_action', correctionRetryPending: false, recoverableCorrectionRounds: 0 }
}
