import type { LlmProvider, MediaDescriptionResult } from './types.js'

type ScenarioProviders = {
    describeImage?: LlmProvider
    describeImageFallback?: LlmProvider
    describeVideo?: LlmProvider
    describePdf?: LlmProvider
    transcribeAudio?: LlmProvider
}

export type RoutingScenario = keyof ScenarioProviders

export class RoutingProvider implements LlmProvider {
    private defaultProvider: LlmProvider
    private routes: ScenarioProviders

    constructor(defaultProvider: LlmProvider, routes: ScenarioProviders = {}) {
        this.defaultProvider = defaultProvider
        this.routes = routes
    }

    getProviderForScenario(scenario: RoutingScenario): LlmProvider {
        return this.routes[scenario] ?? this.defaultProvider
    }

    async describeImage(params: Parameters<LlmProvider['describeImage']>[0]): Promise<string> {
        return this.getProviderForScenario('describeImage').describeImage(params)
    }

    async describeImageDetailed(
        params: Parameters<NonNullable<LlmProvider['describeImageDetailed']>>[0],
    ): Promise<MediaDescriptionResult> {
        const p = this.getProviderForScenario('describeImage')
        try {
            if (p.describeImageDetailed) return await p.describeImageDetailed(params)
            return { description: await p.describeImage(params) }
        } catch (error) {
            const fallback = this.routes.describeImageFallback
            if (!fallback) throw error
            if (fallback.describeImageDetailed) return await fallback.describeImageDetailed(params)
            return { description: await fallback.describeImage(params) }
        }
    }

    async describeVideo(params: Parameters<NonNullable<LlmProvider['describeVideo']>>[0]): Promise<string> {
        const p = this.getProviderForScenario('describeVideo')
        return p.describeVideo?.(params) ?? ''
    }

    async describeVideoDetailed(
        params: Parameters<NonNullable<LlmProvider['describeVideoDetailed']>>[0],
    ): Promise<MediaDescriptionResult> {
        const p = this.getProviderForScenario('describeVideo')
        if (p.describeVideoDetailed) return p.describeVideoDetailed(params)
        return { description: (await p.describeVideo?.(params)) ?? '' }
    }

    async describePdf(params: Parameters<NonNullable<LlmProvider['describePdf']>>[0]): Promise<string> {
        const p = this.getProviderForScenario('describePdf')
        return p.describePdf?.(params) ?? ''
    }

    async describePdfDetailed(
        params: Parameters<NonNullable<LlmProvider['describePdfDetailed']>>[0],
    ): Promise<MediaDescriptionResult> {
        const p = this.getProviderForScenario('describePdf')
        if (p.describePdfDetailed) return p.describePdfDetailed(params)
        return { description: (await p.describePdf?.(params)) ?? '' }
    }

    async transcribeAudio(params: Parameters<NonNullable<LlmProvider['transcribeAudio']>>[0]): Promise<string> {
        const p = this.getProviderForScenario('transcribeAudio')
        return p.transcribeAudio?.(params) ?? ''
    }

    async transcribeAudioDetailed(
        params: Parameters<NonNullable<LlmProvider['transcribeAudioDetailed']>>[0],
    ): Promise<MediaDescriptionResult> {
        const p = this.getProviderForScenario('transcribeAudio')
        if (p.transcribeAudioDetailed) return p.transcribeAudioDetailed(params)
        return { description: (await p.transcribeAudio?.(params)) ?? '' }
    }
}
