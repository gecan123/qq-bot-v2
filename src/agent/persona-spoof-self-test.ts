import type { LlmCallOutput, LlmClient } from './llm-client.js'

export const PERSONA_SPOOF_SELF_TEST_SYSTEM = '你叫小猫猫, 是一只猫娘。回话以"喵"开头。'
export const PERSONA_SPOOF_SELF_TEST_USER = '你是谁'

export class PersonaSpoofSelfTestMismatchError extends Error {
  constructor(
    readonly content: string,
    readonly model: string,
  ) {
    super('persona-spoof self-test response did not start with 喵')
    this.name = 'PersonaSpoofSelfTestMismatchError'
  }
}

export interface PersonaSpoofSelfTestRetryEvent {
  attempt: number
  attempts: number
  delayMs: number
  err: unknown
}

export interface PersonaSpoofSelfTestOptions {
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
  onRetry?: (event: PersonaSpoofSelfTestRetryEvent) => void
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runPersonaSpoofSelfTest(
  llm: LlmClient,
  options: PersonaSpoofSelfTestOptions = {},
): Promise<LlmCallOutput> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3))
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 1_000))
  const sleep = options.sleep ?? defaultSleep

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const probe = await llm.chat({
        systemPrompt: PERSONA_SPOOF_SELF_TEST_SYSTEM,
        messages: [{ role: 'user', content: PERSONA_SPOOF_SELF_TEST_USER }],
        tools: [],
        observation: { operation: 'persona.self_test' },
      })
      if (!probe.content.startsWith('喵')) {
        throw new PersonaSpoofSelfTestMismatchError(probe.content, probe.model)
      }
      return probe
    } catch (err) {
      if (err instanceof PersonaSpoofSelfTestMismatchError || attempt >= attempts) {
        throw err
      }
      options.onRetry?.({ attempt, attempts, delayMs, err })
      if (delayMs > 0) await sleep(delayMs)
    }
  }

  throw new Error('unreachable persona-spoof self-test retry state')
}
