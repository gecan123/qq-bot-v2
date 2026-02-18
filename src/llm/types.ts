export interface LlmProvider {
  describeImage(params: { image: Buffer; contentType: string; mediaType?: string }): Promise<string>
  summarizeText(params: { text: string; context?: string }): Promise<string>
  transcribeAudio?(params: { audio: Buffer; contentType: string }): Promise<string>
}
