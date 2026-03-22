import OpenAI from 'openai'
import type { LlmProvider } from './types.js'
import { loadPrompt } from '../config/prompt-loader.js'

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

        return response.choices[0]?.message.content?.trim() ?? ''
    }

    async summarizeText(params: { text: string; context?: string }): Promise<string> {
        const userText = params.context ? `上下文：${params.context}\n\n内容：${params.text}` : params.text

        const response = await this.client.chat.completions.create({
            model: this.model,
            temperature: 0.3,
            messages: [
                { role: 'system', content: loadPrompt('./prompts/summarize-text.md') },
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
            systemPrompt + '\n\n---\n' + loadPrompt('./prompts/reply-instruction.md')

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
        const base64 = params.audio.toString('base64')
        const ext = (params.contentType.split('/')[1] ?? 'mp3') as 'mp3' | 'wav' | 'ogg' | 'flac' | 'webm' | 'mp4'

        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: loadPrompt('./prompts/transcribe-audio.md') },
                    { type: 'input_audio', input_audio: { data: base64, format: ext } } as any,
                ],
            }],
        })

        return response.choices[0]?.message.content?.trim() ?? ''
    }
}
