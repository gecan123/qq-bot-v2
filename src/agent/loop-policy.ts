export type ToolContinuationPolicy = 'immediate' | 'wait_attention' | 'wait_event' | 'backoff' | 'stop'
export type LoopDemand = 'none' | 'continuation' | 'attention'

export interface LoopPolicyInput {
  ranRound: boolean
  stopRequested: boolean
  toolCallCount: number
  demand: LoopDemand
  recoverableToolFailure: boolean
  onlyHelpToolCalls: boolean
  madeToolProgress: boolean
  toolContinuation?: ToolContinuationPolicy
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
        | 'attention_pending'
      recoverableCorrectionRounds: number
    }
  | {
      action: 'wait_attention'
      reason: 'tool_backoff'
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
  if (input.demand === 'attention') {
    return {
      action: 'continue', reason: 'attention_pending',
      recoverableCorrectionRounds: input.recoverableCorrectionRounds,
    }
  }

  let correctionRounds = input.recoverableCorrectionRounds
  if (input.toolCallCount > 0) {
    const continuingCorrection = input.recoverableToolFailure
      || (correctionRounds > 0 && input.onlyHelpToolCalls)
    if (continuingCorrection && correctionRounds < input.maxRecoverableCorrectionRounds) {
      return {
        action: 'continue', reason: 'recoverable_tool_correction',
        recoverableCorrectionRounds: correctionRounds + 1,
      }
    }
    if (!input.recoverableToolFailure && !input.onlyHelpToolCalls) correctionRounds = 0
    if (input.toolContinuation === 'immediate') {
      return { action: 'continue', reason: 'tool_immediate', recoverableCorrectionRounds: correctionRounds }
    }
    if (input.toolContinuation === 'wait_event') {
      return { action: 'continue', reason: 'tool_external_started', recoverableCorrectionRounds: 0 }
    }
    if (input.toolContinuation === 'stop' || input.toolContinuation === 'wait_attention') {
      return { action: 'continue', reason: 'tool_direction_complete', recoverableCorrectionRounds: correctionRounds }
    }
    if (input.toolContinuation === 'backoff') {
      return {
        action: 'wait_attention', reason: 'tool_backoff',
        timeout: 'action_retry',
        recoverableCorrectionRounds: correctionRounds,
      }
    }
    if (input.madeToolProgress) {
      return { action: 'continue', reason: 'tool_progress', recoverableCorrectionRounds: correctionRounds }
    }
    if (input.demand === 'continuation') {
      return { action: 'continue', reason: 'action_correction', recoverableCorrectionRounds: correctionRounds }
    }
    return {
      action: 'continue', reason: 'tool_no_progress',
      recoverableCorrectionRounds: correctionRounds,
    }
  }

  if (input.demand === 'continuation') {
    return { action: 'continue', reason: 'action_correction', recoverableCorrectionRounds: correctionRounds }
  }
  return { action: 'continue', reason: 'seek_next_action', recoverableCorrectionRounds: 0 }
}
