import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodeAssistServer } from './gemini-cli-provier.js'
import type { LlmProvider } from './types.js'
import { loadPrompt } from '../config/prompt-loader.js'

const DEFAULT_MODEL = 'gemini-2.5-flash'
const PROJECT_ID = 'luna-2-449613'

export class GeminiProvider implements LlmProvider {
    private server = new CodeAssistServer(PROJECT_ID)
    private model: string

    constructor(model = DEFAULT_MODEL) {
        this.model = model
    }

    private extractText(response: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }): string {
        const parts = response.candidates?.[0]?.content?.parts
        if (!parts) return ''
        return parts
            .filter((p) => !p.thought)
            .map((p) => p.text ?? '')
            .join('')
    }

    async describeImage(params: { image: Buffer; contentType: string; mediaType?: string }): Promise<string> {
        const base64 = params.image.toString('base64')
        const mediaLabel = params.mediaType === 'sticker' ? '表情包/贴纸' : params.mediaType === 'video' ? '视频截图' : '图片'

        const response = await this.server.generateContent({
            model: this.model,
            contents: [{
                role: 'user',
                parts: [
                    { text: `请描述这张${mediaLabel}：` },
                    { inlineData: { mimeType: params.contentType, data: base64 } },
                ],
            }],
            config: {
                systemInstruction: loadPrompt('./prompts/describe-image.md').replace('{mediaLabel}', mediaLabel),
                temperature: 0.3,
            },
        })

        return this.extractText(response).trim()
    }

    async summarizeText(params: { text: string; context?: string }): Promise<string> {
        const userText = params.context ? `上下文：${params.context}\n\n内容：${params.text}` : params.text

        const response = await this.server.generateContent({
            model: this.model,
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            config: {
                systemInstruction: loadPrompt('./prompts/summarize-text.md'),
                temperature: 0.3,
            },
        })

        return this.extractText(response).trim()
    }


    async generateText(systemInstruction: string, prompt: string): Promise<string> {
        const response = await this.server.generateContent({
            model: this.model,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { systemInstruction, temperature: 0.4 },
        })
        return this.extractText(response).trim()
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

        const response = await this.server.generateContent({
            model: this.model,
            contents: [{
                role: 'user',
                parts: [{ text: userMessage }],
            }],
            config: {
                systemInstruction: fullSystemPrompt,
                temperature: 0.8,
            },
        })
        return this.extractText(response).trim()
    }

    async transcribeAudio(params: { audio: Buffer; contentType: string }): Promise<string> {
        const base64 = params.audio.toString('base64')

        const response = await this.server.generateContent({
            model: this.model,
            contents: [{
                role: 'user',
                parts: [
                    { text: '请转录以下音频内容：' },
                    { inlineData: { mimeType: params.contentType, data: base64 } },
                ],
            }],
            config: {
                systemInstruction: loadPrompt('./prompts/transcribe-audio.md'),
                temperature: 0.3,
            },
        })

        return this.extractText(response)
            .split('\n')
            .map((line) => line.trim())
            .join(' ')
            .trim()
    }
}

export function isGeminiAvailable(): boolean {
    return fs.existsSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json'))
        || fs.existsSync(path.join('.gemini', 'oauth_creds.json'))
}
