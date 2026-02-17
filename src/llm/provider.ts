import type { LlmProvider } from './types.js'

let provider: LlmProvider | undefined

export function setLlmProvider(p: LlmProvider): void {
  provider = p
}

export function getLlmProvider(): LlmProvider | undefined {
  return provider
}
