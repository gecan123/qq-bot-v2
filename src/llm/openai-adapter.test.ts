import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { OpenAIProvider } from './openai-adapter.js'

describe('OpenAIProvider media file inputs', () => {
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

  test('generateGroupMemorySummary requests structured output', async () => {
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
                    summary: '群里最近主要在约饭，整体节奏快。',
                    topics: ['约饭', '火锅'],
                    activePatterns: ['中午和晚饭前更活跃'],
                    styleTags: ['务实', '热闹'],
                  }),
                },
              }],
            }
          },
        },
      },
    }

    const result = await provider.generateGroupMemorySummary('memory-system', 'prompt-body')

    assert.equal(calls.length, 1)
    assert.equal(calls[0].response_format.type, 'json_schema')
    assert.equal(calls[0].response_format.json_schema.name, 'group_memory_summary')
    assert.deepEqual(result, {
      summary: '群里最近主要在约饭，整体节奏快。',
      topics: ['约饭', '火锅'],
      activePatterns: ['中午和晚饭前更活跃'],
      styleTags: ['务实', '热闹'],
    })
  })

  test('generateUserMemoryProfile requests structured output', async () => {
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
                    profile: '说话直接，习惯快速确认安排。',
                    traits: ['直接', '靠谱'],
                    interests: ['聚餐'],
                    speakingStyle: ['短句', '推进式'],
                    examples: ['周六去吃火锅吗', '我可以负责订位'],
                  }),
                },
              }],
            }
          },
        },
      },
    }

    const result = await provider.generateUserMemoryProfile('memory-system', 'prompt-body')

    assert.equal(calls.length, 1)
    assert.equal(calls[0].response_format.type, 'json_schema')
    assert.equal(calls[0].response_format.json_schema.name, 'user_memory_profile')
    assert.deepEqual(result, {
      profile: '说话直接，习惯快速确认安排。',
      traits: ['直接', '靠谱'],
      interests: ['聚餐'],
      speakingStyle: ['短句', '推进式'],
      examples: ['周六去吃火锅吗', '我可以负责订位'],
    })
  })

})
