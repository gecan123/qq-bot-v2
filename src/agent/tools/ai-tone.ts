import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Tool } from '../tool.js'

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

const argsSchema = z.object({
  text: z.string().trim().min(1).max(2000).describe('要判断的中文文本, 上限 2000 字符.'),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('可选阈值, 0-1. 不传则使用模型默认阈值.'),
})

type Args = z.infer<typeof argsSchema>

export interface AiToneToolDeps {
  predictor?: AiTonePredictor
}

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

export function createAiToneTool(deps: AiToneToolDeps = {}): Tool<Args> {
  const predictor = deps.predictor ?? predictAiTone

  return {
    name: 'ai_tone',
    description: [
      '判断中文文本更像 AI 腔调还是人味, 返回概率、标签和阈值.',
      '适合发送前自检或改写语气时参考; 短文本、技术长文和刻意模仿都可能误判.',
      '只做风格辅助, 不要把结果当作事实判断或身份判断.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      return { content: JSON.stringify({ ok: true, ...(await predictor(args.text, args.threshold)) }) }
    },
  }
}
