export interface MediaDescriptionResult {
  description: string
  raw?: unknown
}

export interface LlmProvider {
  model?: string
  describeImage(params: { image: Buffer; contentType: string; mediaType?: string }): Promise<string>
  describeImageDetailed?(params: { image: Buffer; contentType: string; mediaType?: string }): Promise<MediaDescriptionResult>
  describeVideo?(params: { video: Buffer; contentType: string; fileName?: string }): Promise<string>
  describeVideoDetailed?(params: { video: Buffer; contentType: string; fileName?: string }): Promise<MediaDescriptionResult>
  describePdf?(params: { file: Buffer; contentType: string; fileName?: string }): Promise<string>
  describePdfDetailed?(params: { file: Buffer; contentType: string; fileName?: string }): Promise<MediaDescriptionResult>
  transcribeAudio?(params: { audio: Buffer; contentType: string }): Promise<string>
  transcribeAudioDetailed?(params: { audio: Buffer; contentType: string }): Promise<MediaDescriptionResult>
}
