import { createLogger } from '../../logger.js'
import type { GateContext, GateResult } from './types.js'

const log = createLogger('PROACTIVE_GATE')

const ONE_HOUR_MS = 60 * 60 * 1000

export function checkGate(ctx: GateContext): GateResult {
  if (ctx.messagesSinceLastEval < ctx.minMessages) {
    log.debug(
      { messagesSinceLastEval: ctx.messagesSinceLastEval, minMessages: ctx.minMessages },
      'gate: 消息数不足',
    )
    return { passed: false, reason: 'insufficient_messages' }
  }

  if (ctx.lastBotReplyAt !== undefined && Date.now() - ctx.lastBotReplyAt < ctx.cooldownMs) {
    log.debug({ cooldownMs: ctx.cooldownMs }, 'gate: cooldown 中')
    return { passed: false, reason: 'cooldown' }
  }

  const now = Date.now()
  const recentCount = ctx.recentProactiveTimestamps.filter((ts) => now - ts < ONE_HOUR_MS).length
  if (recentCount >= ctx.hourlyBudget) {
    log.debug(
      { recentCount, hourlyBudget: ctx.hourlyBudget },
      'gate: 小时预算已用尽',
    )
    return { passed: false, reason: 'budget_exceeded' }
  }

  return { passed: true }
}
