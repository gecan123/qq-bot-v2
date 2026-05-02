import { prisma } from '../database/client.js'
import type { Prisma } from '../generated/prisma/client.js'
import type { AgentContext, AgentContextSnapshot } from './agent-context.js'
import { createAgentContext } from './agent-context.js'
import type { AgentMessage } from './types.js'

const SNAPSHOT_SCHEMA_VERSION = 1

export interface SceneAgentContextStore {
  loadByScene(sceneId: string): Promise<AgentContextSnapshot | null>
  saveByScene(sceneId: string, snapshot: AgentContextSnapshot): Promise<void>
}

/**
 * Prisma 持久化:scene_agent_contexts 表。一条记录 = 一个 scene 的全部 LLM 可见历史。
 * 没有 row 时 loadByScene 返回 null,工厂据此创建空 AgentContext。
 */
export const defaultSceneAgentContextStore: SceneAgentContextStore = {
  async loadByScene(sceneId) {
    const row = await prisma.sceneAgentContext.findUnique({ where: { sceneId } })
    if (!row) return null
    return parseSnapshotJson(row.snapshot)
  },
  async saveByScene(sceneId, snapshot) {
    const data = serializeSnapshot(snapshot) as unknown as Prisma.InputJsonObject
    await prisma.sceneAgentContext.upsert({
      where: { sceneId },
      create: {
        sceneId,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        snapshot: data,
      },
      update: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        snapshot: data,
      },
    })
  },
}

function serializeSnapshot(snapshot: AgentContextSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = { messages: snapshot.messages }
  if (snapshot.lastObservedMessageRowId != null) {
    out['lastObservedMessageRowId'] = snapshot.lastObservedMessageRowId
  }
  return out
}

/**
 * 工厂:为 sceneId 装配一个 AgentContext。首次访问时从 store load(无记录则空起步),
 * 之后每次 mutating 操作完成后 saveByScene 同步落库。
 *
 * 同步落库选项是为了正确性优先(永续上下文的关键不变量是「下一轮 LLM 调用看到的就是落库
 * 的内容」)。如果 IO 成本变高,后续可以改 debounce 或 microtask flush,但要先保证调用方
 * 的契约:appendXxx 完成 = snapshot 已持久化。
 */
export interface CreateSceneAgentContextOptions {
  sceneId: string
  store?: SceneAgentContextStore
}

export async function createSceneAgentContext(
  options: CreateSceneAgentContextOptions,
): Promise<AgentContext> {
  const store = options.store ?? defaultSceneAgentContextStore
  const initial = await store.loadByScene(options.sceneId)
  const inner = createAgentContext({
    initialMessages: initial?.messages ?? [],
    initialLastObservedMessageRowId: initial?.lastObservedMessageRowId,
  })

  return wrapWithPersistence(inner, options.sceneId, store)
}

function wrapWithPersistence(
  inner: AgentContext,
  sceneId: string,
  store: SceneAgentContextStore,
): AgentContext {
  const persist = async () => {
    const snapshot = await inner.exportSnapshot()
    await store.saveByScene(sceneId, snapshot)
  }

  return {
    getSnapshot: inner.getSnapshot,
    exportSnapshot: inner.exportSnapshot,
    getLastObservedMessageRowId: inner.getLastObservedMessageRowId,
    async appendUserMessage(message) {
      await inner.appendUserMessage(message)
      await persist()
    },
    async appendAssistantTurn(message) {
      await inner.appendAssistantTurn(message)
      await persist()
    },
    async appendToolCalls(calls) {
      await inner.appendToolCalls(calls)
      await persist()
    },
    async appendToolResults(results) {
      await inner.appendToolResults(results)
      await persist()
    },
    async replaceMessages(messages) {
      await inner.replaceMessages(messages)
      await persist()
    },
    async restoreFromSnapshot(snapshot) {
      await inner.restoreFromSnapshot(snapshot)
      await persist()
    },
    async reset() {
      await inner.reset()
      await persist()
    },
    async setLastObservedMessageRowId(rowId) {
      await inner.setLastObservedMessageRowId(rowId)
      await persist()
    },
  }
}

function parseSnapshotJson(value: Prisma.JsonValue): AgentContextSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { messages: [] }
  const obj = value as Record<string, unknown>
  const messagesRaw = obj['messages']
  const messages: AgentMessage[] = Array.isArray(messagesRaw) ? (messagesRaw as AgentMessage[]) : []
  const cursor = obj['lastObservedMessageRowId']
  const out: AgentContextSnapshot = { messages }
  if (typeof cursor === 'number' && Number.isSafeInteger(cursor)) {
    out.lastObservedMessageRowId = cursor
  }
  return out
}
