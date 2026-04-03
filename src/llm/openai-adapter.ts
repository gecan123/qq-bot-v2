import OpenAI from 'openai'
import type {
    GroupMemorySummaryResult,
    LlmProvider,
    UserMemoryProfileResult,
} from './types.js'
import { loadPrompt } from '../config/prompt-loader.js'
import { recordCurrentTokenUsage, toTokenUsage } from './token-usage.js'

type StructuredImageDescription = {
    detectedType?: string
    summary?: string
    description?: string
    extractedText?: string[]
}

type StructuredAudioTranscription = {
    transcription?: string
    refer?: boolean
}

const GROUP_MEMORY_SUMMARY_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'group_memory_summary',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                summary: { type: 'string' },
                topics: { type: 'array', items: { type: 'string' } },
                activePatterns: { type: 'array', items: { type: 'string' } },
                styleTags: { type: 'array', items: { type: 'string' } },
            },
            required: ['summary', 'topics', 'activePatterns', 'styleTags'],
        },
    },
} as const

const USER_MEMORY_PROFILE_RESPONSE_FORMAT = {
    type: 'json_schema',
    json_schema: {
        name: 'user_memory_profile',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                profile: { type: 'string' },
                traits: { type: 'array', items: { type: 'string' } },
                interests: { type: 'array', items: { type: 'string' } },
                speakingStyle: { type: 'array', items: { type: 'string' } },
                examples: { type: 'array', items: { type: 'string' } },
            },
            required: ['profile', 'traits', 'interests', 'speakingStyle', 'examples'],
        },
    },
} as const

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
                extractedText: {
                    type: 'array',
                    items: { type: 'string' },
                },
            },
            required: ['detectedType', 'summary', 'description', 'extractedText'],
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
                extractedText: {
                    type: 'array',
                    items: { type: 'string' },
                },
            },
            required: ['detectedType', 'summary', 'description', 'extractedText'],
        },
    },
} as const

export class OpenAIProvider implements LlmProvider {
    private client: OpenAI
    private model: string
    private static readonly MAX_VIDEO_BYTES = 5 * 1024 * 1024

    constructor(baseURL: string, apiKey: string, model: string) {
        this.client = new OpenAI({ baseURL, apiKey })
        this.model = model
    }

    async describeImage(params: { image: Buffer; contentType: string; mediaType?: string }): Promise<string> {
        const base64 = params.image.toString('base64')
        const mediaLabel = params.mediaType === 'sticker' ? '表情包/贴纸' : params.mediaType === 'video' ? '视频截图' : '图片'

        const response = await this.client.chat.completions.create({
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
                        { type: 'image_url', image_url: { url: `data:${params.contentType};base64,${base64}` } },
                    ],
                },
            ],
        })
        recordCurrentTokenUsage('describeImage', toTokenUsage(response.usage))

        const content = response.choices[0]?.message.content?.trim() ?? ''
        return this.formatStructuredImageDescription(content)
    }

    async describeVideo(params: { video: Buffer; contentType: string; fileName?: string }): Promise<string> {
        const video = params.video.length > OpenAIProvider.MAX_VIDEO_BYTES
            ? params.video.subarray(0, OpenAIProvider.MAX_VIDEO_BYTES)
            : params.video

        return this.describeFileWithPrompt({
            promptPath: './prompts/describe-video.md',
            instruction: '请描述这个视频的内容：',
            file: video,
            fileName: params.fileName ?? 'video.mp4',
            responseFormat: VIDEO_DESCRIPTION_RESPONSE_FORMAT as any,
            formatter: (content) => this.formatStructuredImageDescription(content),
        })
    }

    async describePdf(params: { file: Buffer; contentType: string; fileName?: string }): Promise<string> {
        return this.describeFileWithPrompt({
            promptPath: './prompts/describe-pdf.md',
            instruction: '请描述这个 PDF 文档的内容：',
            file: params.file,
            fileName: params.fileName ?? 'document.pdf',
        })
    }

    async generateGroupMemorySummary(
        systemInstruction: string,
        prompt: string,
    ): Promise<GroupMemorySummaryResult> {
        return this.generateStructuredJson<GroupMemorySummaryResult>({
            systemInstruction,
            prompt,
            responseFormat: GROUP_MEMORY_SUMMARY_RESPONSE_FORMAT as any,
            operation: 'generateGroupMemorySummary',
        })
    }

    async generateUserMemoryProfile(
        systemInstruction: string,
        prompt: string,
    ): Promise<UserMemoryProfileResult> {
        return this.generateStructuredJson<UserMemoryProfileResult>({
            systemInstruction,
            prompt,
            responseFormat: USER_MEMORY_PROFILE_RESPONSE_FORMAT as any,
            operation: 'generateUserMemoryProfile',
        })
    }

    async transcribeAudio(params: { audio: Buffer; contentType: string }): Promise<string> {
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
        return this.formatStructuredAudioTranscription(content)
    }

    private async describeFileWithPrompt(params: {
        promptPath: string
        instruction: string
        file: Buffer
        fileName: string
        responseFormat?: any
        formatter?: (content: string) => string
    }): Promise<string> {
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
        return params.formatter ? params.formatter(content) : content
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

        const content = response.choices[0]?.message.content?.trim() ?? ''
        return JSON.parse(content) as T
    }

    private formatStructuredImageDescription(content: string): string {
        if (!content) return ''

        try {
            const parsed = JSON.parse(content) as StructuredImageDescription
            const parts: string[] = []

            const summary = parsed.summary?.trim()
            const description = parsed.description?.trim()
            const extractedText = (parsed.extractedText ?? []).map((item) => item.trim()).filter(Boolean)

            if (summary) parts.push(summary)
            if (description && description !== summary) parts.push(description)
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
            const parsed = JSON.parse(content) as StructuredAudioTranscription
            return parsed.transcription?.trim() ?? ''
        } catch {
            return content
        }
    }
}
