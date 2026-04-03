import type { LlmProvider } from './types.js'

type ScenarioProviders = {
    describeImage?: LlmProvider
    describeVideo?: LlmProvider
    describePdf?: LlmProvider
    generateText?: LlmProvider
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

    async generateText(systemInstruction: string, prompt: string): Promise<string> {
        const p = this.routes.generateText ?? this.defaultProvider
        return p.generateText?.(systemInstruction, prompt) ?? ''
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
