export type ToolContinuationPolicy = 'immediate' | 'wait_attention' | 'wait_event' | 'backoff' | 'stop'

export interface LoopPolicyInput {
  ranRound: boolean
  stopRequested: boolean
  toolCallCount: number
  actionRequired: boolean
  recoverableToolFailure: boolean
  onlyHelpToolCalls: boolean
  madeToolProgress: boolean
  requestedYield: boolean
  toolContinuation?: ToolContinuationPolicy
  correctionRetryPending: boolean
  recoverableCorrectionRounds: number
  maxRecoverableCorrectionRounds: number
}

export type LoopPolicyDecision =
  | { action: 'wait_event'; reason: 'empty_context' | 'tool_external'; recoverableCorrectionRounds: number }
  | { action: 'stop'; recoverableCorrectionRounds: number }
  | { action: 'continue'; reason: 'recoverable_tool_correction' | 'tool_immediate' | 'tool_progress' | 'action_correction'; correctionRetryPending: boolean; resetIdleBackoff: true; recoverableCorrectionRounds: number }
  | { action: 'wait_attention'; reason: 'tool_stop' | 'tool_backoff' | 'tool_no_progress' | 'action_correction' | 'quiescent'; timeout: 'idle' | 'action_retry'; unanchored: boolean; recordIdle: false | 'yield' | 'other'; recoverableCorrectionRounds: number }

export function decideLoopPolicy(input: LoopPolicyInput): LoopPolicyDecision {
  if (!input.ranRound) {
    return input.stopRequested
      ? { action: 'stop', recoverableCorrectionRounds: input.recoverableCorrectionRounds }
      : { action: 'wait_event', reason: 'empty_context', recoverableCorrectionRounds: input.recoverableCorrectionRounds }
  }
  if (input.stopRequested) return { action: 'stop', recoverableCorrectionRounds: input.recoverableCorrectionRounds }

  let correctionRounds = input.recoverableCorrectionRounds
  if (input.toolCallCount > 0) {
    const continuingCorrection = input.recoverableToolFailure
      || (correctionRounds > 0 && input.onlyHelpToolCalls)
    if (continuingCorrection && correctionRounds < input.maxRecoverableCorrectionRounds) {
      return {
        action: 'continue', reason: 'recoverable_tool_correction', correctionRetryPending: false,
        resetIdleBackoff: true, recoverableCorrectionRounds: correctionRounds + 1,
      }
    }
    if (!input.recoverableToolFailure && !input.onlyHelpToolCalls) correctionRounds = 0
    if (input.toolContinuation === 'immediate') {
      return { action: 'continue', reason: 'tool_immediate', correctionRetryPending: false, resetIdleBackoff: true, recoverableCorrectionRounds: correctionRounds }
    }
    if (input.toolContinuation === 'stop') {
      return {
        action: 'wait_attention', reason: 'tool_stop', timeout: 'idle', unanchored: true,
        recordIdle: input.requestedYield && !input.actionRequired ? 'yield' : false,
        recoverableCorrectionRounds: correctionRounds,
      }
    }
    if (input.toolContinuation === 'wait_event') {
      return { action: 'wait_event', reason: 'tool_external', recoverableCorrectionRounds: 0 }
    }
    if (input.toolContinuation === 'backoff' || input.toolContinuation === 'wait_attention') {
      return {
        action: 'wait_attention', reason: 'tool_backoff',
        timeout: input.actionRequired ? 'action_retry' : 'idle',
        unanchored: !input.actionRequired, recordIdle: input.actionRequired ? false : 'other',
        recoverableCorrectionRounds: correctionRounds,
      }
    }
    if (input.madeToolProgress) {
      return { action: 'continue', reason: 'tool_progress', correctionRetryPending: false, resetIdleBackoff: true, recoverableCorrectionRounds: correctionRounds }
    }
    if (input.actionRequired && !input.correctionRetryPending) {
      return { action: 'continue', reason: 'action_correction', correctionRetryPending: true, resetIdleBackoff: true, recoverableCorrectionRounds: correctionRounds }
    }
    return {
      action: 'wait_attention', reason: 'tool_no_progress',
      timeout: input.actionRequired ? 'action_retry' : 'idle',
      unanchored: !input.actionRequired, recordIdle: input.actionRequired ? false : 'other',
      recoverableCorrectionRounds: correctionRounds,
    }
  }

  if (input.actionRequired || input.correctionRetryPending) {
    if (!input.correctionRetryPending) {
      return { action: 'continue', reason: 'action_correction', correctionRetryPending: true, resetIdleBackoff: true, recoverableCorrectionRounds: correctionRounds }
    }
    return { action: 'wait_attention', reason: 'action_correction', timeout: 'action_retry', unanchored: false, recordIdle: false, recoverableCorrectionRounds: correctionRounds }
  }
  return { action: 'wait_attention', reason: 'quiescent', timeout: 'idle', unanchored: true, recordIdle: 'other', recoverableCorrectionRounds: 0 }
}
