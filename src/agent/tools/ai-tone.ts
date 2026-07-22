import { readFileSync } from 'node:fs'

interface AiToneModel {
  ngram_range: [number, number]
  lowercase: boolean
  intercept: number
  threshold: number
  ngrams: Record<string, [number, number]>
}

export interface AiTonePrediction {
  prob: number
  isAI: boolean
  label: 'AI味' | '人味'
  threshold: number
  textLength: number
}

export type AiTonePredictor = (text: string, threshold?: number) => Promise<AiTonePrediction> | AiTonePrediction

let cachedModel: AiToneModel | null = null

function loadModel(): AiToneModel {
  if (!cachedModel) {
    cachedModel = JSON.parse(readFileSync(new URL('./ai-tone/model.json', import.meta.url), 'utf8')) as AiToneModel
  }
  return cachedModel
}

function preprocess(text: string, lowercase: boolean): string[] {
  const normalized = lowercase ? text.toLowerCase() : text
  return Array.from(normalized.replace(/\s\s+/g, ' '))
}

function probability(text: string, model: AiToneModel): number {
  const chars = preprocess(text, model.lowercase)
  const [nMin, nMax] = model.ngram_range
  const counts = new Map<string, number>()

  for (let n = nMin; n <= nMax; n += 1) {
    for (let i = 0; i + n <= chars.length; i += 1) {
      const gram = chars.slice(i, i + n).join('')
      if (model.ngrams[gram]) counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
  }

  let norm = 0
  const values: [number, number][] = []
  for (const [gram, count] of counts) {
    const [idf, coef] = model.ngrams[gram]!
    const value = count * idf
    norm += value * value
    values.push([value, coef])
  }
  norm = Math.sqrt(norm) || 1

  let score = model.intercept
  for (const [value, coef] of values) {
    score += (value / norm) * coef
  }

  return 1 / (1 + Math.exp(-score))
}

export function predictAiTone(text: string, threshold?: number): AiTonePrediction {
  const model = loadModel()
  const effectiveThreshold = threshold ?? model.threshold
  const prob = probability(text, model)
  const isAI = prob >= effectiveThreshold
  return {
    prob,
    isAI,
    label: isAI ? 'AI味' : '人味',
    threshold: effectiveThreshold,
    textLength: Array.from(text).length,
  }
}
