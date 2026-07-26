import {
  ScheduleRuntimeError,
  type CancelScheduleResult,
  type CreateScheduleInput,
  type CreateScheduleResult,
  type ScheduleRuntime,
} from '../agent/schedule-runtime.js'
import type { ScheduleOccurrence } from '../agent/schedule-occurrence-store.js'
import type { ScheduleJob } from '../agent/schedule-store.js'
import { requestJson } from './http.js'

type SchedulerResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ScheduleRuntimeError['code']; message: string; scheduleId?: string } }

export function createRemoteScheduleRuntime(baseUrl: string): ScheduleRuntime {
  const call = async <T>(action: string, input: Record<string, unknown> = {}): Promise<T> => {
    const response = await requestJson<SchedulerResponse<T>>({
      baseUrl,
      path: '/schedule',
      method: 'POST',
      body: { action, ...input },
      timeoutMs: 15_000,
    })
    if (response.ok) return response.value
    throw new ScheduleRuntimeError(response.error.code, response.error.message, {
      scheduleId: response.error.scheduleId,
    })
  }

  return {
    async start() {
      await requestJson({ baseUrl, path: '/health', timeoutMs: 5_000 })
    },
    create(input: CreateScheduleInput): Promise<CreateScheduleResult> {
      return call('create', { input })
    },
    list(): Promise<ScheduleJob[]> {
      return call('list')
    },
    getOccurrence(scheduleId: string): Promise<ScheduleOccurrence | null> {
      return call('get_occurrence', { scheduleId })
    },
    cancel(id: string): Promise<CancelScheduleResult> {
      return call('cancel', { id })
    },
    async stop() {
      // Scheduler 生命周期由独立进程拥有；Agent 关闭只停止客户端。
    },
  }
}
