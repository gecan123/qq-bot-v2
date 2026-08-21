import type { DeliveryRequest, DeliveryResult, PlatformDeliveryAdapter } from '../messaging/message-delivery.js'
import { requestJson } from './http.js'
import type { ConversationSummary } from '../agent/tools/conversation.js'

interface FeishuGatewaySendRequest extends Omit<DeliveryRequest, 'imageBytes'> {
  imageBase64?: string
}

export class FeishuGatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 30_000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  health(): Promise<{ ok: boolean; connected: boolean; botOpenId: string }> {
    return this.request('/health')
  }

  conversations(): Promise<ConversationSummary[]> {
    return this.request<{ conversations: ConversationSummary[] }>('/conversations', {})
      .then((result) => result.conversations)
  }

  send(request: DeliveryRequest): Promise<DeliveryResult> {
    const body: FeishuGatewaySendRequest = {
      ...request,
      ...(request.imageBytes ? { imageBase64: request.imageBytes.toString('base64') } : {}),
    }
    delete (body as { imageBytes?: Buffer }).imageBytes
    return this.request('/send', body)
  }

  private request<T>(path: string, body?: unknown): Promise<T> {
    return requestJson<T>({
      baseUrl: this.baseUrl,
      path,
      ...(body === undefined ? {} : { method: 'POST' as const, body }),
      timeoutMs: this.timeoutMs,
      fetcher: this.fetcher,
    })
  }
}

export function createFeishuDeliveryAdapter(client: FeishuGatewayClient): PlatformDeliveryAdapter {
  return { platform: 'feishu', send: (request) => client.send(request) }
}
