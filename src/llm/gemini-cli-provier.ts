/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Node.js 内置模块
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

// 第三方模块
import { Credentials, OAuth2Client } from 'google-auth-library';
import {
    Candidate,
    Content,
    ContentListUnion,
    ContentUnion,
    GenerateContentConfig,
    GenerateContentParameters,
    GenerateContentResponse,
    GenerateContentResponsePromptFeedback,
    GenerateContentResponseUsageMetadata,
    GenerationConfigRoutingConfig,
    ImageConfig,
    MediaResolution,
    ModelSelectionConfig,
    Part,
    PartUnion,
    SafetySetting,
    SpeechConfigUnion,
    ThinkingConfig,
    ToolConfig,
    ToolListUnion,
} from '@google/genai';

// 常量定义
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';

// 类型定义
/** HTTP options to be used in each of the requests. */
interface HttpOptions {
    /** Additional HTTP headers to be sent with the request. */
    headers?: Record<string, string>;
    baseUrl?: string;
}

interface CAGenerateContentRequest {
    model: string;
    project?: string;
    user_prompt_id?: string;
    request: VertexGenerateContentRequest;
}

interface VertexGenerateContentRequest {
    contents: Content[];
    systemInstruction?: Content;
    cachedContent?: string;
    tools?: ToolListUnion;
    toolConfig?: ToolConfig;
    labels?: Record<string, string>;
    safetySettings?: SafetySetting[];
    generationConfig?: VertexGenerationConfig;
    session_id?: string;
    imageConfig?: ImageConfig;
}

interface VertexGenerationConfig {
    temperature?: number;
    topP?: number;
    topK?: number;
    candidateCount?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseLogprobs?: boolean;
    logprobs?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    seed?: number;
    responseMimeType?: string;
    responseJsonSchema?: unknown;
    responseSchema?: unknown;
    routingConfig?: GenerationConfigRoutingConfig;
    modelSelectionConfig?: ModelSelectionConfig;
    responseModalities?: string[];
    mediaResolution?: MediaResolution;
    speechConfig?: SpeechConfigUnion;
    audioTimestamp?: boolean;
    thinkingConfig?: ThinkingConfig;
}

interface CaGenerateContentResponse {
    response: VertexGenerateContentResponse;
}

interface VertexGenerateContentResponse {
    candidates: Candidate[];
    automaticFunctionCallingHistory?: Content[];
    promptFeedback?: GenerateContentResponsePromptFeedback;
    usageMetadata?: GenerateContentResponseUsageMetadata;
    modelVersion?: string;
}

// 工具函数
function toGenerateContentRequest(
    req: GenerateContentParameters,
    project?: string,
    sessionId?: string,
): CAGenerateContentRequest {
    return {
        model: req.model,
        project,
        user_prompt_id: undefined,
        request: toVertexGenerateContentRequest(req, sessionId),
    };
}

function fromGenerateContentResponse(
    res: CaGenerateContentResponse,
): GenerateContentResponse {
    const inres = res.response;
    const out = new GenerateContentResponse();
    out.candidates = inres.candidates;
    out.automaticFunctionCallingHistory = inres.automaticFunctionCallingHistory;
    out.promptFeedback = inres.promptFeedback;
    out.usageMetadata = inres.usageMetadata;
    out.modelVersion = inres.modelVersion;
    return out;
}

function toVertexGenerateContentRequest(
    req: GenerateContentParameters,
    sessionId?: string,
): VertexGenerateContentRequest {
    return {
        contents: toContents(req.contents),
        systemInstruction: maybeToContent(req.config?.systemInstruction),
        cachedContent: req.config?.cachedContent,
        tools: req.config?.tools,
        toolConfig: req.config?.toolConfig,
        labels: req.config?.labels,
        safetySettings: req.config?.safetySettings,
        generationConfig: toVertexGenerationConfig(req.config),
        session_id: sessionId,
        imageConfig: req.config?.imageConfig
    };
}

function toContents(contents: ContentListUnion): Content[] {
    if (Array.isArray(contents)) {
        // it's a Content[] or a PartsUnion[]
        return contents.map(toContent);
    }
    // it's a Content or a PartsUnion
    return [toContent(contents)];
}

function maybeToContent(content?: ContentUnion): Content | undefined {
    if (!content) {
        return undefined;
    }
    return toContent(content);
}

function toContent(content: ContentUnion): Content {
    if (Array.isArray(content)) {
        // it's a PartsUnion[]
        return {
            role: 'user',
            parts: toParts(content),
        };
    }
    if (typeof content === 'string') {
        // it's a string
        return {
            role: 'user',
            parts: [{ text: content }],
        };
    }
    if ('parts' in content) {
        // it's a Content - process parts to handle thought filtering
        return {
            ...content,
            parts: content.parts
                ? toParts(content.parts.filter((p) => p != null))
                : [],
        };
    }
    // it's a Part
    return {
        role: 'user',
        parts: [toPart(content as Part)],
    };
}

function toParts(parts: PartUnion[]): Part[] {
    return parts.map(toPart);
}

function toPart(part: PartUnion): Part {
    if (typeof part === 'string') {
        // it's a string
        return { text: part };
    }

    // Handle thought parts for CountToken API compatibility
    // The CountToken API expects parts to have certain required "oneof" fields initialized,
    // but thought parts don't conform to this schema and cause API failures
    if ('thought' in part && part.thought) {
        const thoughtText = `[Thought: ${part.thought}]`;

        const newPart = { ...part };
        delete (newPart as Record<string, unknown>)['thought'];

        const hasApiContent =
            'functionCall' in newPart ||
            'functionResponse' in newPart ||
            'inlineData' in newPart ||
            'fileData' in newPart;

        if (hasApiContent) {
            // It's a functionCall or other non-text part. Just strip the thought.
            return newPart;
        }

        // If no other valid API content, this must be a text part.
        // Combine existing text (if any) with the thought, preserving other properties.
        const text = (newPart as { text?: unknown }).text;
        const existingText = text ? String(text) : '';
        const combinedText = existingText
            ? `${existingText}\n${thoughtText}`
            : thoughtText;

        return {
            ...newPart,
            text: combinedText,
        };
    }

    return part;
}

function toVertexGenerationConfig(
    config?: GenerateContentConfig,
): VertexGenerationConfig | undefined {
    if (!config) {
        return undefined;
    }
    return {
        temperature: config.temperature,
        topP: config.topP,
        topK: config.topK,
        candidateCount: config.candidateCount,
        maxOutputTokens: config.maxOutputTokens,
        stopSequences: config.stopSequences,
        responseLogprobs: config.responseLogprobs,
        logprobs: config.logprobs,
        presencePenalty: config.presencePenalty,
        frequencyPenalty: config.frequencyPenalty,
        seed: config.seed,
        responseMimeType: config.responseMimeType,
        responseSchema: config.responseSchema,
        responseJsonSchema: config.responseJsonSchema,
        routingConfig: config.routingConfig,
        modelSelectionConfig: config.modelSelectionConfig,
        responseModalities: config.responseModalities,
        mediaResolution: config.mediaResolution,
        speechConfig: config.speechConfig,
        audioTimestamp: config.audioTimestamp,
        thinkingConfig: config.thinkingConfig,
    };
}

// OAuth 相关工具函数
/**
 * 从文件加载OAuth凭证
 * 优先从当前目录读取，如果没有则从用户主目录读取
 */
function loadOAuthCredentials(): Credentials | null {
    try {
        // 先尝试从当前目录读取
        const localCredsPath = path.join('.gemini', 'oauth_creds.json');
        if (fs.existsSync(localCredsPath)) {
            const credsData = fs.readFileSync(localCredsPath, 'utf8');
            return JSON.parse(credsData);
        }

        // 如果当前目录没有，再从用户主目录读取
        const globalCredsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
        if (fs.existsSync(globalCredsPath)) {
            const credsData = fs.readFileSync(globalCredsPath, 'utf8');
            console.log('[GeminiCLI] 从全局目录加载OAuth凭证');
            return JSON.parse(credsData);
        }

        return null;
    } catch (error) {
        console.warn('[GeminiCLI] OAuth票据加载失败:', (error as Error).message);
        return null;
    }
}

/**
 * 保存OAuth凭证到文件
 */
function saveOAuthCredentials(credentials: Credentials): void {
    try {
        const credsDir = '.gemini';
        const credsPath = path.join(credsDir, 'oauth_creds.json');

        // 确保目录存在
        if (!fs.existsSync(credsDir)) {
            fs.mkdirSync(credsDir, { recursive: true });
        }

        fs.writeFileSync(credsPath, JSON.stringify(credentials, null, 2));
    } catch (error) {
        console.error('[GeminiCLI] OAuth票据刷新失败:', (error as Error).message);
    }
}

// 主要类实现
export class CodeAssistServer {
    private client: OAuth2Client;
    private credLoaded?: Promise<void> = undefined;
    private baseUrl: string;
    constructor(
        readonly projectId?: string,
        readonly httpOptions: HttpOptions = {},
        readonly sessionId?: string,
        baseUrl: string = 'https://cloudcode-pa.googleapis.com',
    ) {
        //这里没有安全风险,是GeminiCli内置固定的信息
        this.client = new OAuth2Client({
            clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
            clientSecret: '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',
            //endpoints: {
            //    oauth2TokenUrl: 'http://192.168.100.247:8000/proxy/googleauth/token'
            //}

        })
        this.baseUrl = baseUrl;
    }

    async loadCred() {
        const codeVerifier = await this.client.generateCodeVerifierAsync();

        // 从文件加载OAuth凭证
        const savedCredentials = loadOAuthCredentials();
        if (savedCredentials) {
            this.client.setCredentials(savedCredentials);
        } else {
            throw new Error('OAuth credentials not found. Please ensure .gemini/oauth_creds.json exists with valid credentials.');
        }

        // 监听凭证更新事件，自动保存到文件
        this.client.on('tokens', (tokens: Credentials) => {
            tokens.refresh_token ??= this.client.credentials.refresh_token;
            saveOAuthCredentials(tokens);
            console.log('[GeminiCLI] OAuth票据刷新,过期时间:', tokens.expiry_date ?? 0);
        });
    }

    async generateContentStream(
        req: GenerateContentParameters,
    ): Promise<AsyncGenerator<GenerateContentResponse>> {
        if (this.credLoaded == undefined) this.credLoaded = this.loadCred();
        await this.credLoaded;
        const resps = await this.requestStreamingPost<CaGenerateContentResponse>(
            'streamGenerateContent',
            toGenerateContentRequest(
                req,
                this.projectId,
                this.sessionId,
            ),
            req.config?.abortSignal,
        );
        return (async function* (): AsyncGenerator<GenerateContentResponse> {
            for await (const resp of resps) {
                yield fromGenerateContentResponse(resp);
            }
        })();
    }

    async generateContent(
        req: GenerateContentParameters,
    ): Promise<GenerateContentResponse> {
        if (this.credLoaded == undefined) this.credLoaded = this.loadCred();
        await this.credLoaded;
        const resp = await this.requestPost<CaGenerateContentResponse>(
            'generateContent',
            toGenerateContentRequest(
                req,
                this.projectId,
                this.sessionId,
            ),
            req.config?.abortSignal,
        );
        return fromGenerateContentResponse(resp);
    }


    private async requestPost<T>(
        method: string,
        req: object,
        signal?: AbortSignal,
    ): Promise<T> {
        const res = await this.client.request({
            url: this.getMethodUrl(method),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.httpOptions.headers,
            },
            responseType: 'json',
            body: JSON.stringify(req),
            signal,
        });
        return res.data as T;
    }

    private async requestGet<T>(method: string, signal?: AbortSignal): Promise<T> {
        const res = await this.client.request({
            url: this.getMethodUrl(method),
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...this.httpOptions.headers,
            },
            responseType: 'json',
            signal,
        });
        return res.data as T;
    }

    private async requestStreamingPost<T>(
        method: string,
        req: object,
        signal?: AbortSignal,
    ): Promise<AsyncGenerator<T>> {
        const res = await this.client.request({
            url: this.getMethodUrl(method),
            method: 'POST',
            params: {
                alt: 'sse',
            },
            headers: {
                'Content-Type': 'application/json',
                ...this.httpOptions.headers,
            },
            responseType: 'stream',
            body: JSON.stringify(req),
            signal,
        });

        return (async function* (): AsyncGenerator<T> {
            const rl = readline.createInterface({
                input: res.data as NodeJS.ReadableStream,
                crlfDelay: Infinity, // Recognizes '\r\n' and '\n' as line breaks
            });

            let bufferedLines: string[] = [];
            for await (const line of rl) {
                // blank lines are used to separate JSON objects in the stream
                if (line === '') {
                    if (bufferedLines.length === 0) {
                        continue; // no data to yield
                    }
                    yield JSON.parse(bufferedLines.join('\n')) as T;
                    bufferedLines = []; // Reset the buffer after yielding
                } else if (line.startsWith('data: ')) {
                    bufferedLines.push(line.slice(6).trim());
                } else {
                    throw new Error(`Unexpected line format in response: ${line}`);
                }
            }
        })();
    }

    private getMethodUrl(method: string): string {
        return `${this.baseUrl}/${CODE_ASSIST_API_VERSION}:${method}`;
    }

    get models() {
        return this;
    }
}

