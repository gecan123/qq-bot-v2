import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { OpenAIProvider } from './openai-adapter.js'

describe('OpenAIProvider media file inputs', () => {
  test('describeVideo sends video as file input', async () => {
    const calls: any[] = []
    const provider = new OpenAIProvider('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.1')
    ;(provider as any).client = {
      chat: {
        completions: {
          create: async (request: any) => {
            calls.push(request)
            return { choices: [{ message: { content: '视频内容描述' } }] }
          },
        },
      },
    }

    const result = await provider.describeVideo({
      video: Buffer.from('video-bytes'),
      contentType: 'video/mp4',
      fileName: 'clip.mp4',
    })

    assert.equal(result, '视频内容描述')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].messages[1].content[1].type, 'file')
    assert.equal(calls[0].messages[1].content[1].file.filename, 'clip.mp4')
    assert.ok(typeof calls[0].messages[1].content[1].file.file_data === 'string')
  })

  test('describePdf sends pdf as file input', async () => {
    const calls: any[] = []
    const provider = new OpenAIProvider('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.1')
    ;(provider as any).client = {
      chat: {
        completions: {
          create: async (request: any) => {
            calls.push(request)
            return { choices: [{ message: { content: 'PDF内容摘要' } }] }
          },
        },
      },
    }

    const result = await provider.describePdf({
      file: Buffer.from('pdf-bytes'),
      contentType: 'application/pdf',
      fileName: 'doc.pdf',
    })

    assert.equal(result, 'PDF内容摘要')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].messages[1].content[1].type, 'file')
    assert.equal(calls[0].messages[1].content[1].file.filename, 'doc.pdf')
    assert.ok(typeof calls[0].messages[1].content[1].file.file_data === 'string')
  })
})
