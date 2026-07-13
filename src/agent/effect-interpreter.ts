import type { ReactToolEffect } from './react-kernel.js'
import { createLogger } from '../logger.js'

const log = createLogger('EFFECT_INTERPRETER')

const PAUSE_EFFECT_TOOLS = new Set(['pause', 'rest'])

export interface EffectInterpretation {
  didPause: boolean
  didCompleteRest: boolean
}

export function interpretToolEffects(effects: ReactToolEffect[]): EffectInterpretation {
  let didPause = false
  let didCompleteRest = false

  for (const item of effects) {
    switch (item.effect.type) {
      case 'pause': {
        if (!PAUSE_EFFECT_TOOLS.has(item.toolName)) {
          log.warn(
            { toolName: item.toolName, toolCallId: item.toolCallId, effectType: item.effect.type },
            'tool_effect_rejected',
          )
          break
        }
        didPause = true
        if (item.effect.status === 'elapsed') didCompleteRest = true
        break
      }
    }
  }

  return { didPause, didCompleteRest }
}
