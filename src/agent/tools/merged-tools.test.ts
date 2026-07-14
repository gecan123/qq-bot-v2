import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import * as zod from 'zod'
import { createInMemoryTaskRegistry } from '../background-task-registry.js'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { Tool, ToolContext } from '../tool.js'
import type { MessageSender } from '../../messaging/message-sender.js'
import { buildBotToolManifest, buildBotTools } from './index.js'
import { createBackgroundTaskTool } from './background-task.js'
import { TASK_RESULT_TEXT_CAP_CHARS } from './get-task-result.js'
import { createMemoryTool, memoryTool } from './memory.js'
import { createFetchImageTool, runCurlImage } from './fetch-image.js'
import { OutboundCache, setOutboundCacheForTest } from '../../media/outbound-cache.js'
import type { SendTargetPolicy } from '../send-target-policy.js'
import type { WorkspaceStateCoordinator } from '../workspace-state-coordinator.js'
import type { ScheduleRuntime } from '../schedule-runtime.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
}

const mockSender: MessageSender = {
  async sendSegments() {
    return { success: true, attempts: 1, providerMessageId: 1 }
  },
}

const targetPolicy: SendTargetPolicy = {
  async authorize() {
    return { allowed: true }
  },
}

const mockWebsiteTool: Tool<{ action: 'status' }> = {
  name: 'website',
  description: 'website',
  schema: zod.object({ action: zod.literal('status') }),
  async execute() {
    return { content: JSON.stringify({ ok: true }) }
  },
}

const disabledOptionalTools = {
  browser: null,
  openbb: null,
  tradingAgent: null,
  website: null,
  webSearch: null,
  cryptoPaper: null,
} as const

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)

describe('merged main-agent tools', () => {
  test('registers schedule only when a schedule runtime is supplied', () => {
    const base = {
      sender: mockSender,
      targetPolicy,
      selfNumber: 999,
      taskRegistry: createInMemoryTaskRegistry(),
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
      qqDirectory: {
        groupIds: [],
        async loadFriends() { return [] },
        async loadGroups() { return [] },
      },
      optionalTools: disabledOptionalTools,
    }
    const scheduleRuntime: ScheduleRuntime = {
      async start() {},
      async create() { throw new Error('not used') },
      async list() { return [] },
      async cancel(id) { return { status: 'already_absent', id } },
      async stop() {},
    }

    assert.equal(
      buildBotToolManifest(base).alwaysOnTools.some((tool) => tool.name === 'schedule'),
      false,
    )
    assert.equal(
      buildBotToolManifest({ ...base, scheduleRuntime }).alwaysOnTools.some((tool) => tool.name === 'schedule'),
      true,
    )
  })

  test('buildBotTools exposes default entries and defers heavy typed tools', () => {
    const names = buildBotTools({
      sender: mockSender,
      targetPolicy,
      selfNumber: 999,
      taskRegistry: createInMemoryTaskRegistry(),
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
      qqDirectory: {
        groupIds: [],
        async loadFriends() { return [] },
        async loadGroups() { return [] },
      },
      optionalTools: disabledOptionalTools,
    }).map((tool) => tool.name)

    assert.ok(names.includes('background_task'))
    assert.ok(names.includes('qq_directory'))
    assert.ok(names.includes('memory'))
    assert.ok(names.includes('inbox'))
    assert.ok(names.includes('pause'))
    assert.ok(names.includes('skill'))
    assert.ok(names.includes('todo'))
    assert.ok(names.includes('help'))
    assert.ok(names.includes('invoke'))
    assert.equal(names.includes('toolbox'), false)
    assert.ok(names.includes('workspace_bash'))
    assert.ok(names.includes('chat_style'))
    assert.ok(names.includes('ai_tone'))
    assert.ok(names.includes('notebook'))
    assert.equal(names.includes('journal'), false)
    assert.ok(names.includes('life_journal'))
    assert.equal(names.includes('skill_editor'), false)
    assert.equal(names.includes('generate_image'), false)
    assert.ok(names.includes('collect_sticker'))
    assert.equal(names.includes('fetch_content'), false)
    assert.equal(names.includes('db'), false)
    assert.equal(names.includes('openbb_cli'), false)
    assert.equal(names.includes('browser'), false)
    assert.equal(names.includes('website'), false)
    assert.equal(names.includes('web_search'), false)
    assert.equal(names.includes('wait'), false)
    assert.equal(names.includes('rest'), false)
    assert.equal(names.includes('reddit'), false)
    assert.equal(names.includes('list_reddit'), false)
    assert.equal(names.includes('get_reddit_post'), false)
    assert.equal(names.includes('check_tasks'), false)
    assert.equal(names.includes('get_task_result'), false)
    assert.equal(names.includes('remember'), false)
    assert.equal(names.includes('recall'), false)
    assert.equal(names.includes('fetch_url'), false)
    assert.equal(names.includes('fetch_image'), false)
    assert.equal(names.includes('style_guide'), false)
    assert.equal(names.includes('group_profile'), false)
    assert.equal(names.includes('source_profile'), false)
    assert.equal(names.includes('write_journal'), false)
    assert.equal(names.includes('download_image'), false)
    assert.equal(names.includes('fetch_avatar'), false)
  })

  test('pause does not enter rest when the idle picker is unavailable', async () => {
    const tools = buildBotTools({
      sender: mockSender,
      targetPolicy,
      selfNumber: 999,
      taskRegistry: createInMemoryTaskRegistry(),
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
      qqDirectory: {
        groupIds: [],
        async loadFriends() { return [] },
        async loadGroups() { return [] },
      },
      optionalTools: disabledOptionalTools,
      restGuide: {
        async pickIdleIntention() {
          return {
            ok: false,
            thought: null,
            intention: null,
            error: 'life journal idle pick timed out after 30000ms',
          }
        },
      },
    })
    const pause = tools.find((tool) => tool.name === 'pause')!

    const result = await pause.execute({
      action: 'rest',
      durationSeconds: 30,
      confirmed: false,
      reason: '刚完成一件事，想停一下',
      intention: {
        primaryDirection: '复核一条 SOL 观察假设的失效条件',
        alternativeDirection: '挑一篇群友文章读第一节',
      },
    } as never, makeCtx())

    assert.deepEqual(result.outcome, {
      ok: false,
      code: 'alternative_check_unavailable',
      error: 'life journal idle pick timed out after 30000ms',
    })
    assert.equal(result.effects, undefined)
    assert.equal(JSON.parse(result.content as string).paused, false)
  })

  test('production manifest shares one coordinator across markdown state tools', async () => {
    const temporaryCwd = await mkdtemp(join(tmpdir(), 'merged-markdown-state-'))
    const originalCwd = process.cwd()
    const resourceKeys: string[] = []
    const workspaceStateCoordinator: WorkspaceStateCoordinator = {
      async withWrite(resourceKey, task) {
        resourceKeys.push(resourceKey)
        return await task()
      },
    }

    try {
      process.chdir(temporaryCwd)
      const manifest = buildBotToolManifest({
        sender: mockSender,
        targetPolicy,
        selfNumber: 999,
        taskRegistry: createInMemoryTaskRegistry(),
        groupIds: [],
        metadata: { groupNames: new Map() },
        groupCustomizations: [],
        qqDirectory: {
          groupIds: [],
          async loadFriends() { return [] },
          async loadGroups() { return [] },
        },
        optionalTools: disabledOptionalTools,
        workspaceStateCoordinator,
      })
      const memory = manifest.alwaysOnTools.find((tool) => tool.name === 'memory')!
      const notebook = manifest.alwaysOnTools.find((tool) => tool.name === 'notebook')!
      const lifeJournal = manifest.alwaysOnTools.find((tool) => tool.name === 'life_journal')!

      await memory.execute({
        action: 'write',
        scope: 'self',
        title: 'runtime-wiring',
        content: '共享 coordinator',
      } as never, makeCtx())
      await notebook.execute({
        action: 'write',
        kind: 'research',
        topic: 'runtime wiring',
        content: '共享 coordinator',
      } as never, makeCtx())
      await lifeJournal.execute({
        action: 'write',
        kind: 'reflection',
        markdown: '共享 coordinator',
      } as never, makeCtx())

      assert.equal(resourceKeys.some((key) => key === 'memory:self/runtime-wiring.md'), true)
      assert.equal(resourceKeys.some((key) => key.startsWith('notebook:research/')), true)
      assert.equal(resourceKeys.some((key) => key.startsWith('life-journal:')), true)
    } finally {
      process.chdir(originalCwd)
      await rm(temporaryCwd, { recursive: true, force: true })
    }
  })

  test('buildBotToolManifest groups deferred capabilities by intent', () => {
    const manifest = buildBotToolManifest({
      sender: mockSender,
      targetPolicy,
      selfNumber: 999,
      taskRegistry: createInMemoryTaskRegistry(),
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
      qqDirectory: {
        groupIds: [],
        async loadFriends() { return [] },
        async loadGroups() { return [] },
      },
      optionalTools: { ...disabledOptionalTools, website: mockWebsiteTool },
    })
    const capabilities = new Map(manifest.capabilities.map((capability) => [
      capability.name,
      capability.tools.map((tool) => tool.name),
    ]))
    const alwaysOnNames = manifest.alwaysOnTools.map((tool) => tool.name)
    const allToolNames = [
      ...alwaysOnNames,
      ...manifest.capabilities.flatMap((capability) => capability.tools.map((tool) => tool.name)),
    ]

    assert.ok(allToolNames.includes('send_message'))
    assert.ok(alwaysOnNames.includes('qq_directory'))
    assert.equal(allToolNames.includes('send_image'), false)
    assert.ok(alwaysOnNames.includes('collect_sticker'))
    assert.ok(alwaysOnNames.includes('chat_style'))
    assert.ok(alwaysOnNames.includes('ai_tone'))
    assert.ok(alwaysOnNames.includes('notebook'))
    assert.equal(alwaysOnNames.includes('journal'), false)
    assert.ok(alwaysOnNames.includes('life_journal'))
    assert.equal(alwaysOnNames.includes('skill_editor'), false)
    assert.deepEqual(capabilities.get('workspace_management'), ['workspace_file'])
    assert.deepEqual(capabilities.get('document_reading'), ['read_file'])
    assert.deepEqual(capabilities.get('skill_management'), ['skill_editor'])
    assert.deepEqual(capabilities.get('media_inspection'), ['inspect_media'])
    assert.ok(capabilities.get('external_research')?.includes('fetch_content'))
    if (capabilities.get('external_research')?.includes('web_search')) {
      assert.deepEqual(capabilities.get('external_research'), ['web_search', 'fetch_content'])
    }
    assert.deepEqual(capabilities.get('media_generation'), ['generate_image'])
    assert.equal(capabilities.has('media_library'), false)
    assert.deepEqual(capabilities.get('media_fetch'), ['fetch_content'])
    assert.deepEqual(capabilities.get('website'), ['website'])
    if (capabilities.has('finance')) assert.deepEqual(capabilities.get('finance'), ['openbb_cli'])
    if (capabilities.has('trading_research')) assert.deepEqual(capabilities.get('trading_research'), ['trading_agent'])
    if (capabilities.has('browser')) assert.deepEqual(capabilities.get('browser'), ['browser'])
  })

  test('background_task action=list and action=get address the same registry', async () => {
    const registry = createInMemoryTaskRegistry()
    const task = registry.register({ toolName: 'generate_image', description: '生成图片' })
    registry.complete(task.id, { summary: 'done', data: { ephemeralRef: 'abc' } })
    const tool = createBackgroundTaskTool({ taskRegistry: registry })

    const listed = JSON.parse((await tool.execute({ action: 'list' }, makeCtx())).content as string) as {
      recentCompleted: { taskId: string }[]
    }
    const detail = await tool.execute({ action: 'get', taskId: task.id }, makeCtx())

    assert.equal(listed.recentCompleted[0]!.taskId, task.id)
    assert.match(JSON.stringify(detail.content), /abc/)
    assert.match(JSON.stringify(detail.content), /send_message imageRef=ephemeral:abc/)
  })

  test('background_task action=get renders batched image metadata with one preview image', async () => {
    const registry = createInMemoryTaskRegistry()
    const task = registry.register({ toolName: 'generate_image', description: '生成图片' })
    registry.complete(task.id, {
      summary: 'done',
      data: {
        images: [
          {
            ephemeralRef: 'a'.repeat(64),
            dataHash: 'a'.repeat(64),
            byteSize: 10,
            contentType: 'image/png',
            description: 'AI generated image 1/2: cat',
          },
          {
            ephemeralRef: 'b'.repeat(64),
            dataHash: 'b'.repeat(64),
            byteSize: 20,
            contentType: 'image/png',
            description: 'AI generated image 2/2: cat',
          },
        ],
        partialSuccess: true,
        requestedCount: 3,
        succeededCount: 2,
        failedCount: 1,
        failures: ['image 3/3: timeout'],
        contextImage: {
          base64: Buffer.from('preview').toString('base64'),
          mediaType: 'image/png',
        },
      },
    })
    const tool = createBackgroundTaskTool({ taskRegistry: registry })

    const detail = await tool.execute({ action: 'get', taskId: task.id }, makeCtx())
    assert.ok(Array.isArray(detail.content))
    const text = detail.content.find((block) => block.type === 'text')
    assert.ok(text && text.type === 'text')
    const parsed = JSON.parse(text.text) as {
      images?: { ephemeralRef: string }[]
      partialSuccess?: boolean
      requestedCount?: number
      succeededCount?: number
      failedCount?: number
      failures?: string[]
      next?: string
    }

    assert.equal(parsed.images?.length, 2)
    assert.equal(parsed.partialSuccess, true)
    assert.equal(parsed.requestedCount, 3)
    assert.equal(parsed.succeededCount, 2)
    assert.equal(parsed.failedCount, 1)
    assert.deepEqual(parsed.failures, ['image 3/3: timeout'])
    assert.equal(parsed.images?.[0]?.ephemeralRef, 'a'.repeat(64))
    assert.equal(parsed.images?.[1]?.ephemeralRef, 'b'.repeat(64))
    assert.match(parsed.next ?? '', /send_message imageRef=ephemeral:/)
    assert.equal(detail.content.filter((block) => block.type === 'image').length, 1)
  })

  test('background_task action=get caps oversized text results as valid JSON', async () => {
    const registry = createInMemoryTaskRegistry()
    const task = registry.register({ toolName: 'future_tool', description: '生成很大的结果' })
    registry.complete(task.id, {
      summary: 'done ' + 's'.repeat(10_000),
      data: {
        description: 'd'.repeat(10_000),
        images: Array.from({ length: 40 }, (_, i) => ({
          ephemeralRef: `${i}`.padStart(64, 'a'),
          dataHash: `${i}`.padStart(64, 'b'),
          byteSize: 10,
          contentType: 'image/png',
          description: 'image ' + 'i'.repeat(10_000),
        })),
        failures: Array.from({ length: 40 }, () => 'f'.repeat(10_000)),
      },
    })
    const tool = createBackgroundTaskTool({ taskRegistry: registry })

    const detail = await tool.execute({ action: 'get', taskId: task.id }, makeCtx())
    assert.ok(Array.isArray(detail.content))
    const text = detail.content.find((block) => block.type === 'text')
    assert.ok(text && text.type === 'text')
    const parsed = JSON.parse(text.text) as { ok: boolean; taskId: string; status: string; truncated?: boolean }

    assert.ok(text.text.length <= TASK_RESULT_TEXT_CAP_CHARS)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.taskId, task.id)
    assert.equal(parsed.status, 'completed')
    assert.equal(parsed.truncated, true)
    assert.doesNotMatch(text.text, /f{1000}/)
  })

  test('background_task keeps a bounded trading result preview and recovery ids', async () => {
    const registry = createInMemoryTaskRegistry()
    const task = registry.register({ toolName: 'trading_agent', description: '研究 BTC' })
    registry.complete(task.id, {
      summary: '研究完成',
      data: {
        sessionId: 'session-1',
        attemptId: 'attempt-1',
        runId: 'run-1',
        result: 'R'.repeat(10_000),
      },
    })
    const tool = createBackgroundTaskTool({ taskRegistry: registry })

    const detail = await tool.execute({ action: 'get', taskId: task.id }, makeCtx())
    assert.ok(Array.isArray(detail.content))
    const text = detail.content.find((block) => block.type === 'text')
    assert.ok(text && text.type === 'text')
    const parsed = JSON.parse(text.text) as Record<string, unknown>

    assert.equal(parsed.sessionId, 'session-1')
    assert.equal(parsed.attemptId, 'attempt-1')
    assert.equal(parsed.runId, 'run-1')
    assert.equal(parsed.truncated, true)
    assert.match(String(parsed.result), /^R+\.\.\.$/)
    assert.ok(text.text.length <= TASK_RESULT_TEXT_CAP_CHARS)
  })

  test('memory action=write/search/read uses markdown-backed memory store', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'merged-memory-'))
    try {
      const tool = createMemoryTool({
        workspaceDir: workspace,
        now: () => new Date('2026-06-27T00:00:00.000Z'),
      })

      const written = JSON.parse((await tool.execute({
        action: 'write',
        scope: 'self',
        title: 'working-notes',
        content: '喜欢冷笑话',
      }, makeCtx())).content as string) as { ok: boolean; file: string }
      const recalled = JSON.parse((await tool.execute({
        action: 'search',
        keyword: '冷笑话',
      }, makeCtx())).content as string) as { matches: { file: string; snippet: string }[] }
      const read = JSON.parse((await tool.execute({
        action: 'read',
        file: written.file,
      }, makeCtx())).content as string) as { ok: boolean; content: string }

      assert.equal(written.ok, true)
      assert.equal(recalled.matches[0]!.file, 'self/working-notes.md')
      assert.match(read.content, /喜欢冷笑话/)
      assert.doesNotThrow(() => zod.toJSONSchema(memoryTool.schema))
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test('internal fetch image implementation produces handles for url and qq_avatar', async () => {
    const cache = new OutboundCache()
    setOutboundCacheForTest(cache)
    try {
      const tool = createFetchImageTool({
        curl: async (url) => ({
          status: 200,
          contentType: String(url).includes('qlogo') ? 'image/png' : 'image/png',
          bytes: TINY_PNG,
          durationMs: 1,
        }),
      })

      const fromUrl = await tool.execute({ action: 'url', url: 'https://example.com/cat.png' }, makeCtx())
      const avatar = await tool.execute({ action: 'qq_avatar', qq: 123, size: '640' }, makeCtx())
      const parsedUrl = JSON.parse(Array.isArray(fromUrl.content) ? fromUrl.content[0]!.type === 'text' ? fromUrl.content[0]!.text : '{}' : fromUrl.content) as { ephemeralRef: string }
      const parsedAvatar = JSON.parse(Array.isArray(avatar.content) ? avatar.content[0]!.type === 'text' ? avatar.content[0]!.text : '{}' : avatar.content) as { ephemeralRef: string }

      assert.equal(Array.isArray(fromUrl.content), true)
      assert.equal(Array.isArray(avatar.content), true)
      assert.ok(Array.isArray(fromUrl.content) && fromUrl.content.some((block) => block.type === 'image'))
      assert.ok(Array.isArray(avatar.content) && avatar.content.some((block) => block.type === 'image'))
      assert.match(parsedUrl.ephemeralRef, /^[a-f0-9]{64}$/)
      assert.match(parsedAvatar.ephemeralRef, /^[a-f0-9]{64}$/)
      assert.ok(cache.get(parsedUrl.ephemeralRef))
      assert.ok(cache.get(parsedAvatar.ephemeralRef))
    } finally {
      setOutboundCacheForTest(null)
    }
  })

  test('runCurlImage fetches bytes from a local HTTP endpoint with curl', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', connection: 'close' })
      res.end(TINY_PNG)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const addr = server.address()
      assert.ok(addr && typeof addr === 'object')
      const result = await runCurlImage(`http://127.0.0.1:${addr.port}/tiny.png`, {
        timeoutMs: 2000,
        maxBytes: 1024 * 1024,
        userAgent: 'qq-bot-v2/test',
      })

      assert.equal(result.status, 200)
      assert.equal(result.contentType, 'image/png')
      assert.deepEqual(result.bytes, TINY_PNG)
      assert.equal(result.errorKind, undefined)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
