export interface GroupMemorySummaryResult {
  summary: string
  topics: string[]
  activePatterns: string[]
  styleTags: string[]
}

export interface UserMemoryProfileResult {
  profile: string
  traits: string[]
  interests: string[]
  speakingStyle: string[]
  examples: string[]
}

export interface LlmProvider {
  describeImage(params: { image: Buffer; contentType: string; mediaType?: string }): Promise<string>
  describeVideo?(params: { video: Buffer; contentType: string; fileName?: string }): Promise<string>
  describePdf?(params: { file: Buffer; contentType: string; fileName?: string }): Promise<string>
  transcribeAudio?(params: { audio: Buffer; contentType: string }): Promise<string>
  generateReply?(systemPrompt: string, context: string, trigger: string): Promise<string>
  generateGroupMemorySummary?(
    systemInstruction: string,
    prompt: string,
  ): Promise<GroupMemorySummaryResult>
  generateUserMemoryProfile?(
    systemInstruction: string,
    prompt: string,
  ): Promise<UserMemoryProfileResult>
}
