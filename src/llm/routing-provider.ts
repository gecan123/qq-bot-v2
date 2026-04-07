import type {
    GroupMemorySummaryResult,
    LlmProvider,
    MediaDescriptionResult,
    UserMemoryProfileResult,
} from './types.js'

type ScenarioProviders = {
    describeImage?: LlmProvider
    describeVideo?: LlmProvider
    describePdf?: LlmProvider
    generateGroupMemorySummary?: LlmProvider
    generateUserMemoryProfile?: LlmProvider
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

    async describeImageDetailed(
        params: Parameters<NonNullable<LlmProvider['describeImageDetailed']>>[0],
    ): Promise<MediaDescriptionResult> {
        const p = this.routes.describeImage ?? this.defaultProvider
        if (p.describeImageDetailed) return p.describeImageDetailed(params)
        return { description: await p.describeImage(params) }
    }

    async describeVideo(params: Parameters<NonNullable<LlmProvider['describeVideo']>>[0]): Promise<string> {
        const p = this.routes.describeVideo ?? this.defaultProvider
        return p.describeVideo?.(params) ?? ''
    }

    async describeVideoDetailed(
        params: Parameters<NonNullable<LlmProvider['describeVideoDetailed']>>[0],
    ): Promise<MediaDescriptionResult> {
        const p = this.routes.describeVideo ?? this.defaultProvider
        if (p.describeVideoDetailed) return p.describeVideoDetailed(params)
        return { description: (await p.describeVideo?.(params)) ?? '' }
    }

    async describePdf(params: Parameters<NonNullable<LlmProvider['describePdf']>>[0]): Promise<string> {
        const p = this.routes.describePdf ?? this.defaultProvider
        return p.describePdf?.(params) ?? ''
    }

    async describePdfDetailed(
        params: Parameters<NonNullable<LlmProvider['describePdfDetailed']>>[0],
    ): Promise<MediaDescriptionResult> {
        const p = this.routes.describePdf ?? this.defaultProvider
        if (p.describePdfDetailed) return p.describePdfDetailed(params)
        return { description: (await p.describePdf?.(params)) ?? '' }
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

    async transcribeAudio(params: Parameters<NonNullable<LlmProvider['transcribeAudio']>>[0]): Promise<string> {
        const p = this.routes.transcribeAudio ?? this.defaultProvider
        return p.transcribeAudio?.(params) ?? ''
    }

    async transcribeAudioDetailed(
        params: Parameters<NonNullable<LlmProvider['transcribeAudioDetailed']>>[0],
    ): Promise<MediaDescriptionResult> {
        const p = this.routes.transcribeAudio ?? this.defaultProvider
        if (p.transcribeAudioDetailed) return p.transcribeAudioDetailed(params)
        return { description: (await p.transcribeAudio?.(params)) ?? '' }
    }
}
