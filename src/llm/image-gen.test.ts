import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { after, before, beforeEach, describe, test } from 'node:test'

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/qq_bot_v2_test'
process.env.NAPCAT_WS_URL = process.env.NAPCAT_WS_URL ?? 'ws://localhost:3001'
process.env.NAPCAT_ACCESS_TOKEN = process.env.NAPCAT_ACCESS_TOKEN ?? 'test-token'
process.env.SELF_NUMBER = process.env.SELF_NUMBER ?? '10000'
process.env.LLM_DEFAULT_PROVIDER = 'openai-agent'
process.env.LLM_DEFAULT_MODEL = 'test-model'
process.env.LLM_PROVIDER_OPENAI_API_KEY = 'test-key'

type CapturedRequest = {
  method: string
  url: string
  contentType: string
  body: Buffer
}

let server: Server
let capturedRequests: CapturedRequest[] = []
let imageGen: typeof import('./image-gen.js')

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function startImageApiServer(): Promise<Server> {
  const testServer = createServer(async (req, res) => {
    const captured = {
      method: req.method ?? '',
      url: req.url ?? '',
      contentType: req.headers['content-type'] ?? '',
      body: await readRequestBody(req),
    }
    capturedRequests.push(captured)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('image-bytes').toString('base64') }] }))
  })
  await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve))
  const address = testServer.address()
  assert.ok(address && typeof address === 'object')
  process.env.LLM_PROVIDER_OPENAI_URL = `http://127.0.0.1:${address.port}/v1`
  return testServer
}

describe('image generation API adapter', () => {
  before(async () => {
    server = await startImageApiServer()
    imageGen = await import('./image-gen.js')
  })

  beforeEach(() => {
    capturedRequests = []
  })

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  })

  test('generateImage defaults quality to low', async () => {
    const image = await imageGen.generateImage('p')

    assert.deepEqual(image, Buffer.from('image-bytes'))
    const captured = capturedRequests[0]
    assert.equal(captured.method, 'POST')
    assert.equal(captured.url, '/v1/images/generations')
    const payload = JSON.parse(captured.body.toString('utf8')) as Record<string, unknown>
    assert.equal(payload?.quality, 'low')
  })

  test('generateImage passes explicit quality', async () => {
    await imageGen.generateImage('p', { quality: 'high' })

    const payload = JSON.parse(capturedRequests[0].body.toString('utf8')) as Record<string, unknown>
    assert.equal(payload?.quality, 'high')
  })

  test('editImage sends multiple source image files and explicit quality', async () => {
    await imageGen.editImage('p', [Buffer.from('source-1'), Buffer.from('source-2')], { quality: 'low' })

    const captured = capturedRequests[0]
    assert.equal(captured.url, '/v1/images/edits')
    assert.match(captured.contentType, /^multipart\/form-data; boundary=/)
    const multipartBody = captured.body.toString('latin1')
    assert.match(multipartBody, /name="quality"\r\n\r\nlow/)
    assert.equal([...multipartBody.matchAll(/name="image(?:\[\])?"/g)].length, 2)
    assert.match(multipartBody, /source-1/)
    assert.match(multipartBody, /source-2/)
  })
})
