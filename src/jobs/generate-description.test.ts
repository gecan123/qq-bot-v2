import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { prisma } from '../database/client.js'
import { setLlmProvider } from '../llm/provider.js'
import { jobQueue } from '../queue/runtime.js'
import { generateDescriptionForMedia } from './generate-description.js'

const originalFindUnique = prisma.media.findUnique
const originalUpdate = prisma.media.update
const originalEnqueue = jobQueue.enqueue

afterEach(() => {
  prisma.media.findUnique = originalFindUnique
  prisma.media.update = originalUpdate
  jobQueue.enqueue = originalEnqueue
  setLlmProvider(undefined as any)
})

describe('generateDescriptionForMedia', () => {
  test('persists raw structured image description alongside flattened text', async () => {
    const updates: any[] = []

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('image-bytes')),
      contentType: 'image/jpeg',
      mediaType: 'image',
      description: null,
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
    assert.equal(updates[0].data.description, '平铺描述')
    assert.deepEqual(updates[0].data.descriptionRaw, {
      detectedType: 'photo',
      summary: '摘要',
      description: '详细描述',
      extractedText: ['文本1'],
    })
  })

  test('does not persist blank image descriptions', async () => {
    const updates: any[] = []
    const enqueued: Array<{ type: string; data: unknown; options?: { priority?: string } }> = []

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('image-bytes')),
      contentType: 'image/jpeg',
      mediaType: 'image',
      description: null,
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

    assert.equal(updates.length, 0)
    assert.deepEqual(enqueued, [])
  })

  test('uses describeVideo for video media', async () => {
    const updates: any[] = []
    let received: any

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('video-bytes')),
      contentType: 'video/mp4',
      mediaType: 'video',
      description: null,
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
        return '视频描述'
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
    assert.equal(updates[0].data.description, '视频描述')
  })

  test('uses describePdf for pdf file media', async () => {
    const updates: any[] = []
    let received: any

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('pdf-bytes')),
      contentType: 'application/pdf',
      mediaType: 'file',
      description: null,
      fileName: 'doc.pdf',
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
        return 'PDF摘要'
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
    assert.equal(updates[0].data.description, 'PDF摘要')
  })

  test('enqueues recent message resolution refresh after description update', async () => {
    const enqueued: Array<{ type: string; data: unknown; options?: { priority?: string } }> = []

    prisma.media.findUnique = (async () => ({
      data: new Uint8Array(Buffer.from('video-bytes')),
      contentType: 'video/mp4',
      mediaType: 'video',
      description: null,
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
      describeVideo: async () => '视频描述',
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
