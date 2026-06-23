import OpenAI, { toFile } from 'openai'
import { config } from '../config/index.js'

const MODEL = 'gpt-image-2'
const SIZE = '1024x1024' as const
const QUALITY = 'medium' as const

export type ImageQuality = 'low' | 'medium' | 'high'

export interface ImageGenerationOptions {
  quality?: ImageQuality
}

function getClient(): OpenAI {
  const provider = config.llm.providers.openai
  if (!provider) {
    throw new Error('需要 LLM_PROVIDER_OPENAI_URL / _API_KEY 指向 cliproxy')
  }
  return new OpenAI({ baseURL: provider.url, apiKey: provider.apiKey })
}

function normalizeImageQuality(value?: ImageQuality): ImageQuality {
  return value ?? QUALITY
}

export async function generateImage(prompt: string, options: ImageGenerationOptions = {}): Promise<Buffer> {
  const client = getClient()
  const result = await client.images.generate({
    model: MODEL,
    prompt,
    size: SIZE,
    quality: normalizeImageQuality(options.quality),
    n: 1,
  })

  const b64 = result.data?.[0]?.b64_json
  if (!b64) {
    throw new Error('GPT image API 返回空数据')
  }
  return Buffer.from(b64, 'base64')
}

export async function editImage(prompt: string, sourceBytes: Buffer[], options: ImageGenerationOptions = {}): Promise<Buffer> {
  const client = getClient()
  const files = await Promise.all(
    sourceBytes.map((bytes, index) => toFile(bytes, `source-${index + 1}.png`, { type: 'image/png' })),
  )
  const result = await client.images.edit({
    model: MODEL,
    image: files,
    prompt,
    size: SIZE,
    quality: normalizeImageQuality(options.quality),
    n: 1,
  })

  const b64 = result.data?.[0]?.b64_json
  if (!b64) {
    throw new Error('GPT image edit API 返回空数据')
  }
  return Buffer.from(b64, 'base64')
}
