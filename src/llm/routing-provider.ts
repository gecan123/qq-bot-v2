import type { GroupMemorySummaryResult, LlmProvider, UserMemoryProfileResult } from './types.js'

type ScenarioProviders = {
    describeImage?: LlmProvider
    describeVideo?: LlmProvider
    describePdf?: LlmProvider
    generateGroupMemorySummary?: LlmProvider
    generateUserMemoryProfile?: LlmProvider
    generateReply?: LlmProvider
    transcribeAudio?: LlmProvider
}

export class RoutingProvider implements LlmProvider {
    private defaultProvider: LlmProvider
    private routes: ScenarioProviders

    constructor(defaultProvider: LlmProvider, routes: ScenarioProviders = {}) {
        this.defaultProvider = defaultProvider
        this.routes = routes
    }

    async describeImage(params: Parameters<LlmProvider['describeImage']>[0]): Promise<string> {
        return (this.routes.describeImage ?? this.defaultProvider).describeImage(params)
    }

    async describeVideo(params: Parameters<NonNullable<LlmProvider['describeVideo']>>[0]): Promise<string> {
        const p = this.routes.describeVideo ?? this.defaultProvider
        return p.describeVideo?.(params) ?? ''
    }

    async describePdf(params: Parameters<NonNullable<LlmProvider['describePdf']>>[0]): Promise<string> {
        const p = this.routes.describePdf ?? this.defaultProvider
        return p.describePdf?.(params) ?? ''
    }

    async generateGroupMemorySummary(systemInstruction: string, prompt: string): Promise<GroupMemorySummaryResult> {
        const p = this.routes.generateGroupMemorySummary ?? this.defaultProvider
        if (!p.generateGroupMemorySummary) {
            throw new Error('generateGroupMemorySummary is not supported by the configured provider')
        }
        return p.generateGroupMemorySummary(systemInstruction, prompt)
    }

    async generateUserMemoryProfile(systemInstruction: string, prompt: string): Promise<UserMemoryProfileResult> {
        const p = this.routes.generateUserMemoryProfile ?? this.defaultProvider
        if (!p.generateUserMemoryProfile) {
            throw new Error('generateUserMemoryProfile is not supported by the configured provider')
        }
        return p.generateUserMemoryProfile(systemInstruction, prompt)
    }

    async generateReply(systemPrompt: string, context: string, trigger: string): Promise<string> {
        const p = this.routes.generateReply ?? this.defaultProvider
        return p.generateReply?.(systemPrompt, context, trigger) ?? ''
    }

    async transcribeAudio(params: Parameters<NonNullable<LlmProvider['transcribeAudio']>>[0]): Promise<string> {
        const p = this.routes.transcribeAudio ?? this.defaultProvider
        return p.transcribeAudio?.(params) ?? ''
    }
}
