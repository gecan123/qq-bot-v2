import type {
  NapcatSegment,
  SendNapcatResult,
  SendTarget,
} from '../messaging/napcat-sender.js'
import type { MessageSender } from '../messaging/message-sender.js'
import { requestJson } from './http.js'

export interface QqGatewayFriend {
  userId: number
  nickname: string
  remark?: string
}

export interface QqGatewayGroup {
  groupId: number
  groupName: string
  groupRemark?: string
  memberCount?: number
  maxMemberCount?: number
}

export interface QqGatewayGroupShutEntry {
  qid: string
  shutUpTime: number
}

export class QqGatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  health(): Promise<{ ok: boolean; connected: boolean; backfillCompleted: boolean }> {
    return this.request('/health')
  }

  friends(): Promise<QqGatewayFriend[]> {
    return this.request<{ friends: QqGatewayFriend[] }>('/friends', {}).then((result) => result.friends)
  }

  groups(): Promise<QqGatewayGroup[]> {
    return this.request<{ groups: QqGatewayGroup[] }>('/groups', {}).then((result) => result.groups)
  }

  groupInfo(groupId: number): Promise<{ groupName?: string }> {
    return this.request('/group-info', { groupId })
  }

  groupShutList(groupId: number): Promise<QqGatewayGroupShutEntry[]> {
    return this.request<{ entries: QqGatewayGroupShutEntry[] }>('/group-shut-list', { groupId })
      .then((result) => result.entries)
  }

  send(target: SendTarget, segments: NapcatSegment[]): Promise<SendNapcatResult> {
    return this.request('/send', { target, segments }, 30_000)
  }

  private request<T>(path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    return requestJson<T>({
      baseUrl: this.baseUrl,
      path,
      ...(body === undefined ? {} : { method: 'POST' as const, body }),
      timeoutMs,
      fetcher: this.fetcher,
    })
  }
}

export function createQqGatewayMessageSender(client: QqGatewayClient): MessageSender {
  return {
    sendSegments: ({ target, segments }) => client.send(target, segments),
  }
}
