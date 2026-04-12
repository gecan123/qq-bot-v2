export interface GateContext {
  readonly lastBotReplyAt: number | undefined
  readonly cooldownMs: number
  readonly recentProactiveTimestamps: readonly number[]
  readonly hourlyBudget: number
  readonly messagesSinceLastEval: number
  readonly minMessages: number
}

export interface GateResult {
  readonly passed: boolean
  readonly reason?: 'cooldown' | 'budget_exceeded' | 'insufficient_messages'
}

export interface ScoreInput {
  readonly messageCount: number
  readonly uniqueSenderCount: number
  readonly silenceSeconds: number
  readonly hasUnansweredQuestion: boolean
}

export interface ScoreBreakdown {
  readonly messages: number
  readonly senders: number
  readonly silence: number
  readonly question: number
  readonly jitter: number
}

export interface ScoreResult {
  readonly score: number
  readonly rawScore: number
  readonly breakdown: ScoreBreakdown
  readonly shouldProceed: boolean
}
