import { createLogger } from '../../logger.js'
import type { ScoreInput, ScoreResult } from './types.js'

const log = createLogger('PROACTIVE_SCORER')

const QUESTION_PATTERN = /[？?]|怎么|什么|如何|有没有|谁知道|求助|帮忙|有人|吗$/

/**
 * 检测最后几条消息中是否有未被回答的问句。
 * 扫描最后 5 行，若发现问句且后续无实质回答（< 2 条或均为短消息 < 5 字），标记为"未回答"。
 */
export function detectUnansweredQuestion(recentLines: readonly string[]): boolean {
  const tail = recentLines.slice(-5)
  let lastQuestionIndex = -1

  for (let i = 0; i < tail.length; i++) {
    if (QUESTION_PATTERN.test(tail[i]!)) {
      lastQuestionIndex = i
    }
  }

  if (lastQuestionIndex === -1) return false

  const afterQuestion = tail.slice(lastQuestionIndex + 1)
  if (afterQuestion.length >= 2) {
    const hasSubstantiveReply = afterQuestion.some((line) => {
      const contentMatch = line.match(/]: (.+)$/)
      return contentMatch !== null && contentMatch[1]!.length >= 5
    })
    if (hasSubstantiveReply) return false
  }

  return true
}

export function computeOpportunityScore(input: ScoreInput, threshold: number): ScoreResult {
  const messages = Math.min(input.messageCount / 12, 1) * 30
  const senders = Math.min(input.uniqueSenderCount / 4, 1) * 25
  const silence = Math.min(Math.max(0, input.silenceSeconds) / 180, 1) * 20
  const question = input.hasUnansweredQuestion ? 25 : 0

  const rawScore = messages + senders + silence + question

  const nearThreshold = Math.abs(rawScore - threshold) <= 8
  const jitter = nearThreshold ? Math.random() * 20 - 10 : 0
  const score = rawScore + jitter

  const shouldProceed = score >= threshold

  const result: ScoreResult = {
    score: Math.round(score * 10) / 10,
    rawScore: Math.round(rawScore * 10) / 10,
    breakdown: {
      messages: Math.round(messages * 10) / 10,
      senders: Math.round(senders * 10) / 10,
      silence: Math.round(silence * 10) / 10,
      question,
      jitter: Math.round(jitter * 10) / 10,
    },
    shouldProceed,
  }

  log.info(result, 'engagement_score')
  return result
}
