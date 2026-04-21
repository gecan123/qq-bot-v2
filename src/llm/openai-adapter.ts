import OpenAI from 'openai'
import { jsonrepair } from 'jsonrepair'
import sharp from 'sharp'
import type { LlmProvider, MediaDescriptionResult } from './types.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { recordCurrentTokenUsage, toTokenUsage } from './token-usage.js'

type StructuredImageDescription = {
    detectedType?: string
    summary?: string
    description?: string
    extractedText?: string[]
    memeContext?: string
    confidence?: number
    intentSignal?: string
}

type StructuredAudioTranscription = {
    transcription?: string
    refer?: boolean
}

const IMAGE_DESCRIPTION_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'image_description',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                detectedType: { type: 'string' },
                summary: { type: 'string' },
                description: { type: 'string' },
                extractedText: { type: 'array', items: { type: 'string' } },
                memeContext: { type: 'string' },
                confidence: { type: 'number' },
                intentSignal: { type: 'string' },
            },
            required: ['detectedType', 'summary', 'description', 'extractedText', 'memeContext', 'confidence', 'intentSignal'],
        },
    },
} as const

const AUDIO_TRANSCRIPTION_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'audio_transcription',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                transcription: { type: 'string' },
                refer: { type: 'boolean' },
            },
            required: ['transcription', 'refer'],
        },
    },
} as const

const VIDEO_DESCRIPTION_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'video_description',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                detectedType: { type: 'string' },
                summary: { type: 'string' },
                description: { type: 'string' },
                extractedText: { type: 'array', items: { type: 'string' } },
            },
            required: ['detectedType', 'summary', 'description', 'extractedText'],
        },
    },
} as const

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_COMPRESSION_QUALITIES = [85, 70, 55, 40] as const

function stripJsonFence(content: string): string {
    return content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
}

class EmptyStructuredResponseError extends Error {
    rawResponse: unknown

    constructor(operation: string, rawResponse: unknown) {
        super(`Empty structured response for ${operation}`)
        this.name = 'EmptyStructuredResponseError'
        this.rawResponse = rawResponse
    }
}

function assertStructuredContentNotEmpty(content: string, operation: string, rawResponse: unknown): void {
    if (!content.trim()) {
        throw new EmptyStructuredResponseError(operation, rawResponse)
    }
}

function parseStructuredContent<T>(content: string): T {
    const stripped = stripJsonFence(content)
    try {
        return JSON.parse(stripped) as T
    } catch {
        return JSON.parse(jsonrepair(stripped)) as T
    }
}

type ImageStreamMode = 'off' | 'fallback' | 'on'

interface OpenAIProviderOptions {
    imageStreamMode?: ImageStreamMode
}

function assertValidBaseURL(baseURL: string): void {
    let parsed: URL
    try {
        parsed = new URL(baseURL)
    } catch {
        throw new Error(`Invalid LLM baseURL: "${baseURL}"`)
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Invalid LLM baseURL: "${baseURL}"`)
    }
}

export class OpenAIProvider implements LlmProvider {
    private client: OpenAI
    readonly model: string
    private imageStreamMode: ImageStreamMode
    private static readonly MAX_VIDEO_BYTES = 5 * 1024 * 1024

    constructor(baseURL: string, apiKey: string, model: string, options: OpenAIProviderOptions = {}) {
        assertValidBaseURL(baseURL)
        this.client = new OpenAI({ baseURL, apiKey })
        this.model = model
        this.imageStreamMode = options.imageStreamMode ?? 'off'
    }

    async describeImage(params: { image: Buffer; contentType: string; mediaType?: string }): Promise<string> {
        const result = await this.describeImageDetailed(params)
        return result.description
    }

    async describeImageDetailed(
        params: { image: Buffer; contentType: string; mediaType?: string },
    ): Promise<MediaDescriptionResult> {
        const prepared = await this.prepareImageForRequest(params.image, params.contentType)
        const base64 = prepared.image.toString('base64')
        const mediaLabel = params.mediaType === 'sticker' ? '表情包/贴纸' : params.mediaType === 'video' ? '视频截图' : '图片'

        const request = {
            model: this.model,
            temperature: 0.3,
            response_format: IMAGE_DESCRIPTION_RESPONSE_FORMAT as any,
            messages: [
                {
                    role: 'system',
                    content: loadPrompt('./prompts/describe-image.md').replace('{mediaLabel}', mediaLabel),
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: `请描述这张${mediaLabel}：` },
                        { type: 'image_url', image_url: { url: `data:${prepared.contentType};base64,${base64}` } },
                    ],
                },
            ],
        }
        const content = await this.createTextCompletionWithStreamFallback(
            request,
            'describeImage',
            this.imageStreamMode,
        )
        return {
            description: this.formatStructuredImageDescription(content),
            raw: this.tryParseStructuredContent(content),
        }
    }

    async describeVideo(params: { video: Buffer; contentType: string; fileName?: string }): Promise<string> {
        const result = await this.describeVideoDetailed(params)
        return result.description
    }

    async describeVideoDetailed(params: {
        video: Buffer
        contentType: string
        fileName?: string
    }): Promise<MediaDescriptionResult> {
        const video = params.video.length > OpenAIProvider.MAX_VIDEO_BYTES
            ? params.video.subarray(0, OpenAIProvider.MAX_VIDEO_BYTES)
            : params.video

        return this.describeFileWithPrompt({
            promptPath: './prompts/describe-video.md',
            instruction: '请描述这个视频的内容：',
            file: video,
            fileName: params.fileName ?? 'video.mp4',
            responseFormat: VIDEO_DESCRIPTION_RESPONSE_FORMAT as any,
            formatter: (content) => ({
                description: this.formatStructuredImageDescription(content),
                raw: this.tryParseStructuredContent(content),
            }),
        })
    }

    async describePdf(params: { file: Buffer; contentType: string; fileName?: string }): Promise<string> {
        const result = await this.describePdfDetailed(params)
        return result.description
    }

    async describePdfDetailed(params: { file: Buffer; contentType: string; fileName?: string }): Promise<MediaDescriptionResult> {
        return this.describeFileWithPrompt({
            promptPath: './prompts/describe-pdf.md',
            instruction: '请描述这个 PDF 文档的内容：',
            file: params.file,
            fileName: params.fileName ?? 'document.pdf',
        })
    }

    async transcribeAudio(params: { audio: Buffer; contentType: string }): Promise<string> {
        const result = await this.transcribeAudioDetailed(params)
        return result.description
    }

    async transcribeAudioDetailed(params: { audio: Buffer; contentType: string }): Promise<MediaDescriptionResult> {
        const base64 = params.audio.toString('base64')
        const ext = (params.contentType.split('/')[1] ?? 'mp3') as 'mp3' | 'wav' | 'ogg' | 'flac' | 'webm' | 'mp4'

        const response = await this.client.chat.completions.create({
            model: this.model,
            response_format: AUDIO_TRANSCRIPTION_RESPONSE_FORMAT as any,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: loadPrompt('./prompts/transcribe-audio.md') },
                    { type: 'input_audio', input_audio: { data: base64, format: ext } } as any,
                ],
            }],
        })
        recordCurrentTokenUsage('transcribeAudio', toTokenUsage(response.usage))

        const content = response.choices[0]?.message.content?.trim() ?? ''
        return {
            description: this.formatStructuredAudioTranscription(content),
            raw: this.tryParseStructuredContent(content),
        }
    }

    private async describeFileWithPrompt(params: {
        promptPath: string
        instruction: string
        file: Buffer
        fileName: string
        responseFormat?: any
        formatter?: (content: string) => MediaDescriptionResult
    }): Promise<MediaDescriptionResult> {
        const response = await this.client.chat.completions.create({
            model: this.model,
            temperature: 0.3,
            response_format: params.responseFormat,
            messages: [
                {
                    role: 'system',
                    content: loadPrompt(params.promptPath),
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: params.instruction },
                        {
                            type: 'file',
                            file: {
                                file_data: params.file.toString('base64'),
                                filename: params.fileName,
                            },
                        },
                    ],
                },
            ],
        })
        recordCurrentTokenUsage(
            params.promptPath.includes('describe-video') ? 'describeVideo' : 'describePdf',
            toTokenUsage(response.usage),
        )

        const content = response.choices[0]?.message.content?.trim() ?? ''
        return params.formatter ? params.formatter(content) : { description: content }
    }

    private async generateStructuredJson<T>(params: {
        systemInstruction: string
        prompt: string
        responseFormat: any
        operation: string
    }): Promise<T> {
        const response = await this.client.chat.completions.create({
            model: this.model,
            temperature: 0.3,
            response_format: params.responseFormat,
            messages: [
                { role: 'system', content: params.systemInstruction },
                { role: 'user', content: params.prompt },
            ],
        })
        recordCurrentTokenUsage(params.operation, toTokenUsage(response.usage))

        const raw = response.choices[0]?.message.content?.trim() ?? ''
        assertStructuredContentNotEmpty(raw, params.operation, response)
        return parseStructuredContent<T>(raw)
    }

    private formatStructuredImageDescription(content: string): string {
        if (!content) return ''

        try {
            const parsed = parseStructuredContent<StructuredImageDescription>(content)
            const parts: string[] = []

            const summary = parsed.summary?.trim()
            const description = parsed.description?.trim()
            const extractedText = (parsed.extractedText ?? []).map((item) => item.trim()).filter(Boolean)
            const memeContext = parsed.memeContext?.trim()

            if (summary) parts.push(summary)
            if (description && description !== summary) parts.push(description)
            if (memeContext) parts.push(`[梗图背景：${memeContext}]`)
            if (extractedText.length > 0) {
                parts.push(`图中文字：${extractedText.join('；')}`)
            }

            return parts.join(' ')
        } catch {
            return content
        }
    }

    private formatStructuredAudioTranscription(content: string): string {
        if (!content) return ''

        try {
            const parsed = parseStructuredContent<StructuredAudioTranscription>(content)
            return parsed.transcription?.trim() ?? ''
        } catch {
            return content
        }
    }

    private tryParseStructuredContent(content: string): unknown {
        if (!content) return undefined
        try {
            return parseStructuredContent<unknown>(content)
        } catch {
            return undefined
        }
    }

    private async createTextCompletionWithStreamFallback(
        request: any,
        operation: string,
        mode: ImageStreamMode,
    ): Promise<string> {
        if (mode === 'on') {
            const streamed = await this.createStreamingTextCompletion(request, operation)
            return streamed.trim()
        }

        const response = await this.client.chat.completions.create(request)
        const content = response.choices[0]?.message.content?.trim() ?? ''
        if (content || mode !== 'fallback') {
            recordCurrentTokenUsage(operation, toTokenUsage(response.usage))
            return content
        }

        return this.createStreamingTextCompletion(request, operation)
    }

    private async createStreamingTextCompletion(request: any, operation: string): Promise<string> {
        const stream = await this.client.chat.completions.create({
            ...request,
            stream: true,
            stream_options: { include_usage: true },
        } as any) as unknown as AsyncIterable<any>

        let streamedContent = ''
        let usage: any
        for await (const chunk of stream) {
            usage = chunk.usage ?? usage
            const delta = chunk.choices?.[0]?.delta?.content
            if (typeof delta === 'string') streamedContent += delta
        }

        if (usage) {
            recordCurrentTokenUsage(operation, toTokenUsage(usage))
        }

        return streamedContent.trim()
    }

    private async prepareImageForRequest(
        image: Buffer,
        contentType: string,
    ): Promise<{ image: Buffer; contentType: string }> {
        if (image.length <= MAX_IMAGE_BYTES) {
            return { image, contentType }
        }

        let metadata: sharp.Metadata
        try {
            metadata = await sharp(image, { animated: false }).metadata()
        } catch {
            return { image, contentType }
        }

        const originalWidth = metadata.width ?? null
        const resizeWidths = [
            originalWidth,
            originalWidth ? Math.max(Math.floor(originalWidth * 0.85), 256) : null,
            originalWidth ? Math.max(Math.floor(originalWidth * 0.7), 256) : null,
            originalWidth ? Math.max(Math.floor(originalWidth * 0.55), 256) : null,
        ]

        for (const width of resizeWidths) {
            for (const quality of IMAGE_COMPRESSION_QUALITIES) {
                let pipeline = sharp(image, { animated: false, limitInputPixels: false }).rotate()
                if (width && originalWidth && width < originalWidth) {
                    pipeline = pipeline.resize({ width, withoutEnlargement: true })
                }

                const compressed = await pipeline
                    .jpeg({
                        quality,
                        mozjpeg: true,
                    })
                    .toBuffer()

                if (compressed.length <= MAX_IMAGE_BYTES) {
                    return {
                        image: compressed,
                        contentType: 'image/jpeg',
                    }
                }
            }
        }

        return { image, contentType }
    }
}
