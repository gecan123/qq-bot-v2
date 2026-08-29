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
  noProgressRounds: number
  maxNoProgressRounds: number
}

interface LoopPolicyState {
  recoverableCorrectionRounds: number
  noProgressRounds: number
}

export type LoopPolicyDecision = (
  | {
      action: 'wait_event'
      reason:
        | 'no_actionable_context'
        | 'tool_external_started'
        | 'tool_direction_complete'
        | 'no_progress_limit'
        | 'direction_complete'
    }
  | { action: 'stop' }
  | {
      action: 'continue'
      reason:
        | 'recoverable_tool_correction'
        | 'tool_immediate'
        | 'tool_progress'
        | 'action_correction'
        | 'tool_no_progress'
        | 'attention_pending'
    }
  | {
      action: 'wait_attention'
      reason: 'tool_backoff'
      timeout: 'action_retry'
    }
) & LoopPolicyState

export function decideLoopPolicy(input: LoopPolicyInput): LoopPolicyDecision {
  if (!input.ranRound) {
    return input.stopRequested
      ? state(input, { action: 'stop' })
      : state(input, { action: 'wait_event', reason: 'no_actionable_context' }, { noProgressRounds: 0 })
  }
  if (input.stopRequested) return state(input, { action: 'stop' })
  if (input.demand === 'attention') {
    return state(input, { action: 'continue', reason: 'attention_pending' }, { noProgressRounds: 0 })
  }

  let correctionRounds = input.recoverableCorrectionRounds
  if (input.toolCallCount > 0) {
    const continuingCorrection = input.recoverableToolFailure
      || (correctionRounds > 0 && input.onlyHelpToolCalls)
    if (continuingCorrection && correctionRounds < input.maxRecoverableCorrectionRounds) {
      return state(input, { action: 'continue', reason: 'recoverable_tool_correction' }, {
        recoverableCorrectionRounds: correctionRounds + 1,
      })
    }
    if (!input.recoverableToolFailure && !input.onlyHelpToolCalls) correctionRounds = 0
    if (input.toolContinuation === 'wait_event') {
      return state(input, { action: 'wait_event', reason: 'tool_external_started' }, {
        recoverableCorrectionRounds: 0,
        noProgressRounds: 0,
      })
    }
    if (input.toolContinuation === 'stop' || input.toolContinuation === 'wait_attention') {
      return state(input, { action: 'wait_event', reason: 'tool_direction_complete' }, {
        recoverableCorrectionRounds: correctionRounds,
        noProgressRounds: 0,
      })
    }
    if (input.toolContinuation === 'backoff') {
      return state(input, {
        action: 'wait_attention', reason: 'tool_backoff', timeout: 'action_retry',
      }, { recoverableCorrectionRounds: correctionRounds })
    }
    if (input.madeToolProgress) {
      return state(input, {
        action: 'continue',
        reason: input.toolContinuation === 'immediate' ? 'tool_immediate' : 'tool_progress',
      }, { recoverableCorrectionRounds: correctionRounds, noProgressRounds: 0 })
    }
    if (input.demand === 'continuation') {
      return state(input, { action: 'continue', reason: 'action_correction' }, {
        recoverableCorrectionRounds: correctionRounds,
        noProgressRounds: 0,
      })
    }
    const noProgressRounds = input.noProgressRounds + 1
    if (noProgressRounds >= Math.max(1, input.maxNoProgressRounds)) {
      return state(input, { action: 'wait_event', reason: 'no_progress_limit' }, {
        recoverableCorrectionRounds: correctionRounds,
        noProgressRounds: 0,
      })
    }
    return state(input, { action: 'continue', reason: 'tool_no_progress' }, {
      recoverableCorrectionRounds: correctionRounds,
      noProgressRounds,
    })
  }

  if (input.demand === 'continuation') {
    return state(input, { action: 'continue', reason: 'action_correction' }, {
      recoverableCorrectionRounds: correctionRounds,
      noProgressRounds: 0,
    })
  }
  return state(input, { action: 'wait_event', reason: 'direction_complete' }, {
    recoverableCorrectionRounds: 0,
    noProgressRounds: 0,
  })
}

function state<TDecision extends Omit<LoopPolicyDecision, keyof LoopPolicyState>>(
  input: LoopPolicyInput,
  decision: TDecision,
  overrides: Partial<LoopPolicyState> = {},
): TDecision & LoopPolicyState {
  return {
    ...decision,
    recoverableCorrectionRounds:
      overrides.recoverableCorrectionRounds ?? input.recoverableCorrectionRounds,
    noProgressRounds: overrides.noProgressRounds ?? input.noProgressRounds,
  }
}
