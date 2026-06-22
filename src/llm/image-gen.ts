import OpenAI, { toFile } from 'openai'
import { config } from '../config/index.js'

const MODEL = 'gpt-image-2'
const SIZE = '1024x1024' as const
const QUALITY = 'medium' as const

function getClient(): OpenAI {
  const provider = config.llm.providers.openai
  if (!provider) {
    throw new Error('需要 LLM_PROVIDER_OPENAI_URL / _API_KEY 指向 cliproxy')
  }
  return new OpenAI({ baseURL: provider.url, apiKey: provider.apiKey })
}

export async function generateImage(prompt: string): Promise<Buffer> {
  const client = getClient()
  const result = await client.images.generate({
    model: MODEL,
    prompt,
    size: SIZE,
    quality: QUALITY,
    n: 1,
  })

  const b64 = result.data?.[0]?.b64_json
  if (!b64) {
    throw new Error('GPT image API 返回空数据')
  }
  return Buffer.from(b64, 'base64')
}

export async function editImage(prompt: string, sourceBytes: Buffer): Promise<Buffer> {
  const client = getClient()
  const file = await toFile(sourceBytes, 'source.png', { type: 'image/png' })
  const result = await client.images.edit({
    model: MODEL,
    image: file,
    prompt,
    size: SIZE,
    n: 1,
  })

  const b64 = result.data?.[0]?.b64_json
  if (!b64) {
    throw new Error('GPT image edit API 返回空数据')
  }
  return Buffer.from(b64, 'base64')
}
