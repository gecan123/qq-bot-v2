import type { NCWebsocket } from 'node-napcat-ts'
import { createLogger } from '../logger.js'

const log = createLogger('META_RESOLVE')

const PER_CALL_TIMEOUT_MS = 3_000

/**
 * Maps populated once at startup, used to build the system prompt's
 * "我监听这些源" section.
 *
 * Process-immutable (AGENTS.md / CLAUDE.md 红线 5): 这些 map 在启动后不再变。
 *
 * 想让 system prompt 里看到该群的新名字, 必须重启 bot ——
 * 重启时整段 cache 失效本来就是预期, 不是 bug.
 *
 * 私聊不在这里预解析: 私聊白名单已删除, 接受任意好友 DM, 由 ingress 层
 * sub_type='friend' 过滤; 昵称走 per-event render (render-event.ts).
 */
export interface TargetMetadataMaps {
  /** groupId → groupName.  Empty / unresolvable entries fall back to bare ID at the call site. */
  groupNames: Map<number, string>
}

interface ResolveTargetMetadataMapsInput {
  napcat: Pick<NCWebsocket, 'get_group_info'>
  groupIds: readonly number[]
  perCallTimeoutMs?: number
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (val) => {
        clearTimeout(timer)
        resolve(val)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function normalizedString(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim()
}

/**
 * 启动时一次性拉取每个群白名单 ID 的人类可读名字, 用于 system prompt 拼装。
 *
 * 行为:
 *  - 每个调用独立 `Promise.allSettled`, 单个失败不传染 (D6).
 *  - 每个调用 3 秒超时 (D2 / D6), 卡死的 NapCat 不会拖 bot 启动.
 *  - 失败 / 超时 / 空字符串都 → map 里不写该 entry, 调用端 fallback 到裸 ID (D2).
 *
 * 必须在 napcat.connect() 之后调 (D2): 不连接的 socket 上 get_* API 一定 timeout.
 */
export async function resolveTargetMetadataMaps(
  input: ResolveTargetMetadataMapsInput,
): Promise<TargetMetadataMaps> {
  const timeout = input.perCallTimeoutMs ?? PER_CALL_TIMEOUT_MS
  const groupNames = new Map<number, string>()

  const groupTasks = input.groupIds.map(async (groupId) => {
    try {
      const info = await withTimeout(
        input.napcat.get_group_info({ group_id: groupId }),
        timeout,
        `get_group_info(${groupId})`,
      )
      const name = normalizedString((info as { group_name?: string }).group_name)
      if (name) groupNames.set(groupId, name)
    } catch (err) {
      log.warn({ groupId, err }, 'resolve_group_name_failed_falling_back_to_bare_id')
    }
  })

  await Promise.allSettled(groupTasks)

  log.info(
    {
      groupResolved: groupNames.size,
      groupTotal: input.groupIds.length,
    },
    'target_metadata_resolved',
  )

  return { groupNames }
}
