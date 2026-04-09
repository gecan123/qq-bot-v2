import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import { setLlmProvider } from '../llm/provider.js'
import { RoutingProvider } from '../llm/routing-provider.js'
import { log } from '../logger.js'
import { jobQueue } from '../queue/runtime.js'
import { generateDescriptionForMedia } from './generate-description.js'

const originalFindUnique = prisma.media.findUnique
const originalUpdate = prisma.media.update
const originalEnqueue = jobQueue.enqueue
const originalInfo = log.info
const originalWarn = log.warn

afterEach(() => {
  prisma.media.findUnique = originalFindUnique
  prisma.media.update = originalUpdate
  jobQueue.enqueue = originalEnqueue
  log.info = originalInfo
  log.warn = originalWarn
  setLlmProvider(undefined as any)
})

describe('generateDescriptionForMedia', () => {
  test('persists only structured image description', async () => {
    const updates: any[] = []

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('image-bytes')),
      contentType: 'image/jpeg',
      mediaType: 'image',
      descriptionRaw: null,
      fileName: 'frame.jpg',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async (args: any) => {
      updates.push(args)
      return {} as any
    }) as typeof prisma.media.update

    setLlmProvider({
      describeImage: async () => '平铺描述',
      describeImageDetailed: async () => ({
        description: '平铺描述',
        raw: {
          detectedType: 'photo',
          summary: '摘要',
          description: '详细描述',
          extractedText: ['文本1'],
        },
      }),
      describeVideo: async () => '',
      describePdf: async () => '',
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async () => '',
    })

    await generateDescriptionForMedia(1)

    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].data.descriptionRaw, {
      detectedType: 'photo',
      summary: '摘要',
      description: '详细描述',
      extractedText: ['文本1'],
    })
  })

  test('falls back to sensitive_content when image description is blank', async () => {
    const updates: any[] = []
    const enqueued: Array<{ type: string; data: unknown; options?: { priority?: string } }> = []

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('image-bytes')),
      contentType: 'image/jpeg',
      mediaType: 'image',
      descriptionRaw: null,
      fileName: 'frame.jpg',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async (args: any) => {
      updates.push(args)
      return {} as any
    }) as typeof prisma.media.update

    jobQueue.enqueue = ((type: string, data: unknown, options?: { priority?: string }) => {
      enqueued.push({ type, data, options })
    }) as typeof jobQueue.enqueue

    setLlmProvider({
      describeImage: async () => '   ',
      describeImageDetailed: async () => ({
        description: '   ',
        raw: null,
      }),
      describeVideo: async () => '',
      describePdf: async () => '',
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async () => '',
    })

    await generateDescriptionForMedia(1)

    assert.equal(updates.length, 1)
    assert.equal(updates[0].data.descriptionRaw.detectedType, 'sensitive_content')
    assert.equal(updates[0].data.descriptionRaw.confidence, 0.1)
    assert.deepEqual(enqueued, [{ type: 'refresh-message-resolution', data: { mediaId: 1 }, options: { priority: 'low' } }])
  })

  test('logs model and duration when image description is generated', async () => {
    const infos: Array<{ object: Record<string, unknown>; message: string | undefined }> = []

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('image-bytes')),
      contentType: 'image/jpeg',
      mediaType: 'image',
      descriptionRaw: null,
      fileName: 'frame.jpg',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async () => {
      return {} as any
    }) as typeof prisma.media.update

    log.info = ((object: Record<string, unknown>, message?: string) => {
      infos.push({ object, message })
    }) as typeof log.info

    setLlmProvider({
      model: 'gpt-5.4-mini',
      describeImage: async () => '平铺描述',
      describeImageDetailed: async () => ({
        description: '平铺描述',
        raw: {
          detectedType: 'photo',
          summary: '摘要',
          description: '详细描述',
        },
      }),
      describeVideo: async () => '',
      describePdf: async () => '',
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async () => '',
    } as any)

    await generateDescriptionForMedia(22)

    assert.equal(infos.length, 1)
    assert.equal(infos[0]?.message, '媒体描述已生成')
    assert.equal(infos[0]?.object.mediaId, 22)
    assert.equal(infos[0]?.object.model, 'gpt-5.4-mini')
    assert.equal(typeof infos[0]?.object.durationMs, 'number')
  })

  test('logs routed provider model when image description is generated through routing provider', async () => {
    const infos: Array<{ object: Record<string, unknown>; message: string | undefined }> = []

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('image-bytes')),
      contentType: 'image/jpeg',
      mediaType: 'image',
      descriptionRaw: null,
      fileName: 'frame.jpg',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async () => {
      return {} as any
    }) as typeof prisma.media.update

    log.info = ((object: Record<string, unknown>, message?: string) => {
      infos.push({ object, message })
    }) as typeof log.info

    const defaultProvider = {
      model: 'gpt-5.1',
      describeImage: async () => 'default description',
      describeVideo: async () => '',
      describePdf: async () => '',
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async () => '',
    }

    const describeImageProvider = {
      model: 'gpt-5.4-mini',
      describeImage: async () => 'image description',
      describeImageDetailed: async () => ({
        description: 'image description',
        raw: { description: 'image description' },
      }),
    }

    setLlmProvider(new RoutingProvider(defaultProvider as any, { describeImage: describeImageProvider as any }))

    await generateDescriptionForMedia(23)

    assert.equal(infos.length, 1)
    assert.equal(infos[0]?.message, '媒体描述已生成')
    assert.equal(infos[0]?.object.mediaId, 23)
    assert.equal(infos[0]?.object.model, 'gpt-5.4-mini')
  })

  test('logs llm response and writes sensitive_content fallback when image description result is invalid', async () => {
    const warnings: Array<{ object: Record<string, unknown>; message: string | undefined }> = []
    const updates: any[] = []

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('image-bytes')),
      contentType: 'image/jpeg',
      mediaType: 'image',
      descriptionRaw: null,
      fileName: 'frame.jpg',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async (args: any) => {
      updates.push(args)
      return {} as any
    }) as typeof prisma.media.update

    log.warn = ((object: Record<string, unknown>, message?: string) => {
      warnings.push({ object, message })
    }) as typeof log.warn

    setLlmProvider({
      describeImage: async () => '   ',
      describeImageDetailed: async () => ({
        description: '   ',
        raw: ['bad-shape'],
      }),
      describeVideo: async () => '',
      describePdf: async () => '',
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async () => '',
    })

    await generateDescriptionForMedia(333)

    assert.equal(warnings.length, 1)
    assert.equal(warnings[0]?.message, '媒体描述结果不是有效对象，保留待解析状态')
    assert.equal(warnings[0]?.object.mediaId, 333)
    assert.equal(warnings[0]?.object.mediaType, 'image')
    assert.equal(warnings[0]?.object.llmDescription, '   ')
    assert.deepEqual(warnings[0]?.object.llmRaw, ['bad-shape'])
    assert.equal(updates.length, 1)
    assert.equal(updates[0].data.descriptionRaw.detectedType, 'sensitive_content')
  })

  test('uses describeVideo for video media', async () => {
    const updates: any[] = []
    let received: any

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('video-bytes')),
      contentType: 'video/mp4',
      mediaType: 'video',
      descriptionRaw: null,
      fileName: 'clip.mp4',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async (args: any) => {
      updates.push(args)
      return {} as any
    }) as typeof prisma.media.update

    setLlmProvider({
      describeImage: async () => '',
      describeVideo: async () => '',
      describeVideoDetailed: async (params) => {
        received = params
        return {
          description: '视频描述',
          raw: { description: '视频描述', summary: '摘要' },
        }
      },
      describePdf: async () => '',
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async () => '',
    })

    await generateDescriptionForMedia(1)

    assert.equal(received.contentType, 'video/mp4')
    assert.equal(received.fileName, 'clip.mp4')
    assert.equal(Buffer.isBuffer(received.video), true)
    assert.deepEqual(updates[0].data.descriptionRaw, { description: '视频描述', summary: '摘要' })
  })

  test('falls back to legacy describeVideo when detailed method is unavailable', async () => {
    const updates: any[] = []
    let received: any

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('video-bytes')),
      contentType: 'video/mp4',
      mediaType: 'video',
      descriptionRaw: null,
      fileName: 'clip.mp4',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async (args: any) => {
      updates.push(args)
      return {} as any
    }) as typeof prisma.media.update

    setLlmProvider({
      describeImage: async () => '',
      describeVideo: async (params) => {
        received = params
        return '旧接口视频描述'
      },
      describePdf: async () => '',
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async () => '',
    })

    await generateDescriptionForMedia(11)

    assert.equal(received.contentType, 'video/mp4')
    assert.equal(received.fileName, 'clip.mp4')
    assert.equal(Buffer.isBuffer(received.video), true)
    assert.deepEqual(updates[0].data.descriptionRaw, { description: '旧接口视频描述' })
  })

  test('uses describePdf for pdf file media', async () => {
    const updates: any[] = []
    let received: any

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('pdf-bytes')),
      contentType: 'application/pdf',
      mediaType: 'file',
      descriptionRaw: null,
      fileName: 'doc.pdf',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async (args: any) => {
      updates.push(args)
      return {} as any
    }) as typeof prisma.media.update

    setLlmProvider({
      describeImage: async () => '',
      describeVideo: async () => '',
      describePdf: async () => '',
      describePdfDetailed: async (params) => {
        received = params
        return {
          description: 'PDF摘要',
          raw: { description: 'PDF摘要', pageCount: 3 },
        }
      },
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async () => '',
    })

    await generateDescriptionForMedia(2)

    assert.equal(received.contentType, 'application/pdf')
    assert.equal(received.fileName, 'doc.pdf')
    assert.equal(Buffer.isBuffer(received.file), true)
    assert.deepEqual(updates[0].data.descriptionRaw, { description: 'PDF摘要', pageCount: 3 })
  })

  test('falls back to legacy transcribeAudio when detailed method is unavailable', async () => {
    const updates: any[] = []
    let received: any

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('audio-bytes')),
      contentType: 'audio/mp4',
      mediaType: 'record',
      descriptionRaw: null,
      fileName: 'voice.m4a',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async (args: any) => {
      updates.push(args)
      return {} as any
    }) as typeof prisma.media.update

    setLlmProvider({
      describeImage: async () => '',
      describeVideo: async () => '',
      describePdf: async () => '',
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async (params) => {
        received = params
        return '旧接口语音转写'
      },
    })

    await generateDescriptionForMedia(12)

    assert.equal(received.contentType, 'audio/mp4')
    assert.equal(Buffer.isBuffer(received.audio), true)
    assert.deepEqual(updates[0].data.descriptionRaw, { description: '旧接口语音转写' })
  })

  test('falls back to legacy describePdf when detailed method is unavailable', async () => {
    const updates: any[] = []
    let received: any

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('pdf-bytes')),
      contentType: 'application/pdf',
      mediaType: 'file',
      descriptionRaw: null,
      fileName: 'legacy.pdf',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async (args: any) => {
      updates.push(args)
      return {} as any
    }) as typeof prisma.media.update

    setLlmProvider({
      describeImage: async () => '',
      describeVideo: async () => '',
      describePdf: async (params) => {
        received = params
        return '旧接口PDF描述'
      },
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async () => '',
    })

    await generateDescriptionForMedia(13)

    assert.equal(received.contentType, 'application/pdf')
    assert.equal(received.fileName, 'legacy.pdf')
    assert.equal(Buffer.isBuffer(received.file), true)
    assert.deepEqual(updates[0].data.descriptionRaw, { description: '旧接口PDF描述' })
  })

  test('enqueues recent message resolution refresh after description update', async () => {
    const enqueued: Array<{ type: string; data: unknown; options?: { priority?: string } }> = []

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('video-bytes')),
      contentType: 'video/mp4',
      mediaType: 'video',
      descriptionRaw: null,
      fileName: 'clip.mp4',
    })) as unknown as typeof prisma.media.findUnique

    prisma.media.update = (async () => {
      return {} as any
    }) as typeof prisma.media.update

    jobQueue.enqueue = ((type: string, data: unknown, options?: { priority?: string }) => {
      enqueued.push({ type, data, options })
    }) as typeof jobQueue.enqueue

    setLlmProvider({
      describeImage: async () => '',
      describeVideo: async () => '',
      describeVideoDetailed: async () => ({
        description: '视频描述',
        raw: { description: '视频描述' },
      }),
      describePdf: async () => '',
      generateGroupMemorySummary: async () => ({
        summary: '',
        topics: [],
        activePatterns: [],
        styleTags: [],
      }),
      generateUserMemoryProfile: async () => ({
        profile: '',
        traits: [],
        interests: [],
        speakingStyle: [],
        examples: [],
      }),
      transcribeAudio: async () => '',
    })

    await generateDescriptionForMedia(3)

    assert.deepEqual(enqueued, [
      {
        type: 'refresh-message-resolution',
        data: { mediaId: 3 },
        options: { priority: 'low' },
      },
    ])
  })
})
