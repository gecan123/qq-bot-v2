import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodeAssistServer } from './gemini-cli-provier.js'
import type { LlmProvider } from './types.js'

const MODEL = 'gemini-2.5-flash'
const PROJECT_ID = 'luna-2-449613'

export class GeminiProvider implements LlmProvider {
    private server = new CodeAssistServer(PROJECT_ID)

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
            model: MODEL,
            contents: [{
                role: 'user',
                parts: [
                    { text: `请描述这张${mediaLabel}：` },
                    { inlineData: { mimeType: params.contentType, data: base64 } },
                ],
            }],
            config: {
                systemInstruction: `你是一个图片描述助手。请简洁地描述这张${mediaLabel}的内容，用中文回答，不超过100字。`,
                temperature: 0.3,
            },
        })

        return this.extractText(response).trim()
    }

    async summarizeText(params: { text: string; context?: string }): Promise<string> {
        const userText = params.context ? `上下文：${params.context}\n\n内容：${params.text}` : params.text

        const response = await this.server.generateContent({
            model: MODEL,
            contents: [{ role: 'user', parts: [{ text: userText }] }],
            config: {
                systemInstruction: '你是一个文本摘要助手。请简洁地总结以下内容，用中文回答。',
                temperature: 0.3,
            },
        })

        return this.extractText(response).trim()
    }

    async transcribeAudio(params: { audio: Buffer; contentType: string }): Promise<string> {
        const base64 = params.audio.toString('base64')

        const response = await this.server.generateContent({
            model: MODEL,
            contents: [{
                role: 'user',
                parts: [
                    { text: '请转录以下音频内容：' },
                    { inlineData: { mimeType: params.contentType, data: base64 } },
                ],
            }],
            config: {
                systemInstruction: `你是一个专业的音频转录助手。请仔细听取音频内容并提供准确的文字转录。

要求：
1. 准确转录所有听到的内容
2. 保持原意和语气
3. 如果有不清楚的地方，用[不清楚]标注
4. 如果是方言，尽量转为普通话
5. 保持自然的语言表达`,
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
