export interface LlmProvider {
  describeImage(params: { image: Buffer; contentType: string; mediaType?: string }): Promise<string>
  describeVideo?(params: { video: Buffer; contentType: string; fileName?: string }): Promise<string>
  describePdf?(params: { file: Buffer; contentType: string; fileName?: string }): Promise<string>
  transcribeAudio?(params: { audio: Buffer; contentType: string }): Promise<string>
  generateReply?(systemPrompt: string, context: string, trigger: string): Promise<string>
  generateText?(systemInstruction: string, prompt: string): Promise<string>
}
