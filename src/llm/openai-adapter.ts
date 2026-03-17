import OpenAI from 'openai'
import type { LlmProvider } from './types.js'

export class OpenAIProvider implements LlmProvider {
    private client: OpenAI
    private model: string

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
            messages: [
                {
                    role: 'system',
                    content: `你是一个图片描述助手。请简洁地描述这张${mediaLabel}的内容，用中文回答，不超过100字。`,
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

        return response.choices[0]?.message.content?.trim() ?? ''
    }

    async summarizeText(params: { text: string; context?: string }): Promise<string> {
        const userText = params.context ? `上下文：${params.context}\n\n内容：${params.text}` : params.text

        const response = await this.client.chat.completions.create({
            model: this.model,
            temperature: 0.3,
            messages: [
                { role: 'system', content: '你是一个文本摘要助手。请简洁地总结以下内容，用中文回答。' },
                { role: 'user', content: userText },
            ],
        })

        return response.choices[0]?.message.content?.trim() ?? ''
    }

    async generateText(systemInstruction: string, prompt: string): Promise<string> {
        const response = await this.client.chat.completions.create({
            model: this.model,
            temperature: 0.4,
            messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: prompt },
            ],
        })

        return response.choices[0]?.message.content?.trim() ?? ''
    }

    async generateReply(systemPrompt: string, context: string, trigger: string): Promise<string> {
        const userMessage = [
            '[用户对你说]',
            trigger,
            '',
            '[群聊背景记录（仅供参考）]',
            context || '（无）',
        ].join('\n')

        const fullSystemPrompt =
            systemPrompt +
            '\n\n---\n你的首要任务是回复"[用户对你说]"部分的内容。' +
            '"群聊背景记录"仅供参考，请根据相关性自行判断是否使用，不要主动评论历史内容本身。'

        const response = await this.client.chat.completions.create({
            model: this.model,
            temperature: 0.8,
            messages: [
                { role: 'system', content: fullSystemPrompt },
                { role: 'user', content: userMessage },
            ],
        })

        return response.choices[0]?.message.content?.trim() ?? ''
    }

    async transcribeAudio(params: { audio: Buffer; contentType: string }): Promise<string> {
        const ext = params.contentType.split('/')[1] ?? 'mp3'
        const arrayBuffer = params.audio.buffer.slice(params.audio.byteOffset, params.audio.byteOffset + params.audio.byteLength) as ArrayBuffer
        const file = new File([arrayBuffer], `audio.${ext}`, { type: params.contentType })

        const response = await this.client.audio.transcriptions.create({
            model: 'whisper-1',
            file,
            language: 'zh',
        })

        return response.text.trim()
    }
}
