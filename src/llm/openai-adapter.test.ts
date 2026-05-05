import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { OpenAIProvider } from './openai-adapter.js'

describe('OpenAIProvider media file inputs', () => {
  test('throws a clear error when baseURL is not an absolute http url', () => {
    assert.throws(
      () => new OpenAIProvider('AIzaSy-invalid-key', 'sk-local', 'gpt-5.1'),
      /Invalid LLM baseURL/,
    )
  })

  test('describeImage requests structured output and formats moderate rich description text', async () => {
    const calls: any[] = []
    const provider = new OpenAIProvider('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.1')
    ;(provider as any).client = {
      chat: {
        completions: {
          create: async (request: any) => {
            calls.push(request)
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    detectedType: 'chat_screenshot',
                    summary: '微信群聊天截图，几个人在确认周六晚上七点聚餐。',
                    description: '截图显示大家在讨论去静安寺附近吃火锅，其中一人表示会负责订位。',
                    extractedText: [
                      '小林：周六晚上七点吃火锅？',
                      '阿杰：我可以，静安寺附近都行',
                      'Mia：那我来订位',
                      '这条不会出现在最终文本里',
                    ],
                  }),
                },
              }],
            }
          },
        },
      },
    }

    const result = await provider.describeImage({
      image: Buffer.from('image-bytes'),
      contentType: 'image/jpeg',
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].response_format.type, 'json_schema')
    assert.equal(calls[0].response_format.json_schema.name, 'image_description')
    assert.equal(calls[0].messages[1].content[0].text, '请描述这张图片：')
    assert.match(result, /微信群聊天截图/)
    assert.match(result, /讨论去静安寺附近吃火锅/)
    assert.match(result, /图中文字：小林：周六晚上七点吃火锅？；阿杰：我可以，静安寺附近都行；Mia：那我来订位；这条不会出现在最终文本里/)
  })

  test('describeImage parses fenced structured json responses', async () => {
    const provider = new OpenAIProvider('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.1')
    ;(provider as any).client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: [
                  '```json',
                  JSON.stringify({
                    detectedType: 'news_screenshot',
                    summary: '新闻截图，内容是一则遗产分配报道。',
                    description: '截图展示一篇关于遗产分配的新闻文章页面。',
                    extractedText: ['女首富陈丽华530亿遗产分配'],
                  }, null, 2),
                  '```',
                ].join('\n'),
              },
            }],
          }),
        },
      },
    }

    const result = await provider.describeImage({
      image: Buffer.from('image-bytes'),
      contentType: 'image/jpeg',
    })

    assert.match(result, /新闻截图，内容是一则遗产分配报道/)
    assert.match(result, /截图展示一篇关于遗产分配的新闻文章页面/)
    assert.match(result, /图中文字：女首富陈丽华530亿遗产分配/)
  })

  test('describeImage repairs malformed fenced structured json responses', async () => {
    const provider = new OpenAIProvider('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.1')
    ;(provider as any).client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: [
                  '```json',
                  '{',
                  '  "detectedType": "ui_screenshot",',
                  '  "summary": "商场内一家娱乐游戏厅的店铺外观，以霓虹灯装饰和中文招牌为主。",',
                  '  "description": "这是一张在室内商场拍摄的照片，主招牌为黄色霓虹字"极喜特乐"，下方有"WELCOM"等英文标识。",',
                  '  "extractedText": ["极喜特乐", "WELCOM"]',
                  '}',
                  '```',
                ].join('\n'),
              },
            }],
          }),
        },
      },
    }

    const result = await provider.describeImage({
      image: Buffer.from('image-bytes'),
      contentType: 'image/jpeg',
    })

    assert.match(result, /商场内一家娱乐游戏厅的店铺外观/)
    assert.match(result, /主招牌为黄色霓虹字"极喜特乐"/)
    assert.match(result, /图中文字：极喜特乐；WELCOM/)
    assert.doesNotMatch(result, /^```/)
  })

  test('describeImage returns empty string when provider returns null content', async () => {
    const calls: any[] = []
    const provider = new OpenAIProvider('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.4-mini')
    ;(provider as any).client = {
      chat: {
        completions: {
          create: async (request: any) => {
            calls.push(request)
            return {
              choices: [{
                message: {
                  content: null,
                },
              }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 0,
                total_tokens: 10,
              },
            }
          },
        },
      },
    }

    const result = await provider.describeImage({
      image: Buffer.from('image-bytes'),
      contentType: 'image/gif',
      mediaType: 'sticker',
    })

    assert.equal(calls.length, 1)
    assert.equal(result, '')
  })

  test('describeImage preprocesses oversized images before request', async () => {
    const calls: any[] = []
    const provider = new OpenAIProvider('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.4-mini')
    ;(provider as any).prepareImageForRequest = async () => ({
      image: Buffer.from('compressed-image'),
      contentType: 'image/jpeg',
    })
    ;(provider as any).client = {
      chat: {
        completions: {
          create: async (request: any) => {
            calls.push(request)
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    detectedType: 'photo',
                    summary: '压缩后的图片请求。',
                    description: '请求已使用压缩后的 jpeg 图像。',
                    extractedText: [],
                  }),
                },
              }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 10,
                total_tokens: 20,
              },
            }
          },
        },
      },
    }

    const result = await provider.describeImage({
      image: Buffer.alloc(6 * 1024 * 1024, 1),
      contentType: 'image/png',
    })

    assert.match(result, /压缩后的图片请求/)
    assert.equal(calls.length, 1)
    assert.match(calls[0].messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/)
    assert.equal(
      calls[0].messages[1].content[1].image_url.url,
      `data:image/jpeg;base64,${Buffer.from('compressed-image').toString('base64')}`,
    )
  })

  test('describeVideo sends video as file input', async () => {
    const calls: any[] = []
    const provider = new OpenAIProvider('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.1')
    ;(provider as any).client = {
      chat: {
        completions: {
          create: async (request: any) => {
            calls.push(request)
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    detectedType: 'video_clip',
                    summary: '一段室内聚餐视频，几个人边吃火锅边聊天。',
                    description: '视频前半段拍到桌上的火锅和食材，随后镜头转向正在说笑的人群，能看出气氛轻松热闹。',
                    extractedText: [
                      '生日快乐',
                      '海底捞',
                    ],
                  }),
                },
              }],
            }
          },
        },
      },
    }

    const result = await provider.describeVideo({
      video: Buffer.from('video-bytes'),
      contentType: 'video/mp4',
      fileName: 'clip.mp4',
    })

    assert.match(result, /一段室内聚餐视频/)
    assert.match(result, /镜头转向正在说笑的人群/)
    assert.match(result, /图中文字：生日快乐；海底捞/)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].response_format.type, 'json_schema')
    assert.equal(calls[0].response_format.json_schema.name, 'video_description')
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

  test('transcribeAudio requests structured output and returns transcription text', async () => {
    const calls: any[] = []
    const provider = new OpenAIProvider('http://127.0.0.1:8317/v1', 'sk-local', 'gpt-5.1')
    ;(provider as any).client = {
      chat: {
        completions: {
          create: async (request: any) => {
            calls.push(request)
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    transcription: '小林说周六晚上七点一起吃饭，并问我要不要去。',
                    refer: true,
                  }),
                },
              }],
            }
          },
        },
      },
    }

    const result = await provider.transcribeAudio({
      audio: Buffer.from('audio-bytes'),
      contentType: 'audio/mp3',
    })

    assert.equal(result, '小林说周六晚上七点一起吃饭，并问我要不要去。')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].response_format.type, 'json_schema')
    assert.equal(calls[0].response_format.json_schema.name, 'audio_transcription')
    assert.equal(calls[0].messages[0].content[1].type, 'input_audio')
  })

})
