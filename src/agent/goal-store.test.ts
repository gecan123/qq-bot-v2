import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createStartupGoalControlGate,
  parseGoalControlCommand,
  replayOwnerGoalCommands,
  tryHandleOwnerGoalMessage,
} from './goal-control.js'
import {
  DEFAULT_SELF_GOAL_TOKEN_BUDGET,
  MAX_SELF_GOALS_PER_WINDOW,
  SELF_GOAL_CREATE_COOLDOWN_MS,
  createInMemoryGoalStore,
} from './goal-store.js'
import { createGoalTool } from './tools/goal.js'
import { InMemoryEventQueue } from './event-queue.js'
import type { BotEvent } from './event.js'
import { prisma } from '../database/client.js'

describe('goal control and store', () => {
  const firstCommitment = {
    action: '读取第一份资料并记录一个可验证事实',
    reason: '先建立最小证据基线，再决定后续路线',
    expectedEvidence: '资料 URL 与一条带来源的事实记录',
  }

  test('parses owner control syntax and validates token budgets', () => {
    assert.deepEqual(parseGoalControlCommand('/goal'), { action: 'status' })
    assert.deepEqual(parseGoalControlCommand('/goal --tokens 50000 完成网站验收'), {
      action: 'set',
      objective: '完成网站验收',
      tokenBudget: 50_000,
    })
    assert.deepEqual(parseGoalControlCommand('/goal pause'), { action: 'pause' })
    assert.deepEqual(parseGoalControlCommand('/goal resume --tokens 80000'), {
      action: 'resume',
      tokenBudget: 80_000,
    })
    assert.deepEqual(parseGoalControlCommand('/goal clear'), { action: 'clear' })
    assert.equal(parseGoalControlCommand('goal foo'), null)
    assert.throws(() => parseGoalControlCommand('/goal --tokens 0 x'), /objective|budget/)
  })

  test('only configured owner private messages mutate the singleton goal and duplicate rows are idempotent', async () => {
    const store = createInMemoryGoalStore()
    const ignored = await tryHandleOwnerGoalMessage({
      owner: { qq: 100, name: 'owner' },
      peerId: 200,
      senderId: 200,
      messageRowId: 1,
      renderedText: '/goal 不应创建',
      goalStore: store,
    })
    assert.equal(ignored.handled, false)
    assert.equal(await store.get(), null)

    const created = await tryHandleOwnerGoalMessage({
      owner: { qq: 100, name: 'owner' },
      peerId: 100,
      senderId: 100,
      messageRowId: 2,
      renderedText: '/goal --tokens 100 整理网站并验证构建',
      goalStore: store,
    })
    assert.equal(created.mutation?.code, 'created')
    const goalId = created.mutation?.goal?.goalId
    assert.ok(goalId)

    const duplicate = await store.applyControl({
      messageRowId: 2,
      command: { action: 'set', objective: '不能覆盖', tokenBudget: null },
    })
    assert.equal(duplicate.code, 'duplicate')
    assert.equal((await store.get())?.goalId, goalId)

    const conflict = await store.applyControl({
      messageRowId: 3,
      command: { action: 'set', objective: '另一个目标', tokenBudget: null },
    })
    assert.equal(conflict.code, 'unfinished_goal')
    assert.equal((await store.get())?.objective, '整理网站并验证构建')
  })

  test('Agent can create and abandon a generously budgeted self goal', async () => {
    const store = createInMemoryGoalStore()
    const created = await store.createSelf({
      objective: '持续研究一个真正感兴趣的问题',
      motivation: '我想把零散观察发展成可验证判断',
      completionCriteria: ['形成有来源的结论', '记录反例和失效条件'],
      currentCommitment: firstCommitment,
    })

    assert.equal(created.code, 'created')
    assert.equal(created.goal?.origin, 'self')
    assert.equal(created.goal?.tokenBudget, DEFAULT_SELF_GOAL_TOKEN_BUDGET)
    assert.deepEqual(created.goal?.completionCriteria, ['形成有来源的结论', '记录反例和失效条件'])
    assert.deepEqual(created.goal?.currentCommitment, firstCommitment)
    assert.equal(created.goal?.selfGoalWindowCount, 1)

    const abandoned = await store.abandonSelf({
      goalId: created.goal!.goalId,
      reason: '核心前提被新证据推翻，继续投入已没有价值',
    })
    assert.equal(abandoned.goal?.status, 'abandoned')
  })

  test('owner goal preempts a self goal and stale self calls cannot mutate it', async () => {
    const store = createInMemoryGoalStore()
    const selfGoal = await store.createSelf({
      objective: 'self goal',
      motivation: '想做',
      completionCriteria: ['完成'],
      currentCommitment: firstCommitment,
    })
    const ownerGoal = await store.applyControl({
      messageRowId: 20,
      command: { action: 'set', objective: 'owner goal', tokenBudget: null },
    })

    assert.equal(ownerGoal.code, 'created')
    assert.equal(ownerGoal.goal?.origin, 'owner')
    assert.notEqual(ownerGoal.goal?.goalId, selfGoal.goal?.goalId)
    const stale = await store.abandonSelf({
      goalId: selfGoal.goal!.goalId,
      reason: '迟到调用',
    })
    assert.equal(stale.code, 'stale_goal')
    assert.equal((await store.get())?.objective, 'owner goal')
  })

  test('Agent cannot create over or abandon an active owner goal', async () => {
    const store = createInMemoryGoalStore()
    await store.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: 'owner goal', tokenBudget: null },
    })
    const owner = (await store.get())!
    const create = await store.createSelf({
      objective: 'self goal', motivation: '想做', completionCriteria: ['完成'], currentCommitment: firstCommitment,
    })
    const abandon = await store.abandonSelf({ goalId: owner.goalId, reason: '不想做' })

    assert.equal(create.code, 'owner_goal_active')
    assert.equal(abandon.code, 'owner_goal_active')
    assert.equal((await store.get())?.status, 'active')
  })

  test('self goal frequency limits are wide but stop a runaway creation loop', async () => {
    let nowMs = Date.parse('2026-07-12T00:00:00Z')
    const store = createInMemoryGoalStore(null, { now: () => new Date(nowMs) })
    const first = await store.createSelf({
      objective: 'first', motivation: 'test', completionCriteria: ['done'], currentCommitment: firstCommitment,
    })
    await store.abandonSelf({ goalId: first.goal!.goalId, reason: 'test' })
    const cooldown = await store.createSelf({
      objective: 'too soon', motivation: 'test', completionCriteria: ['done'], currentCommitment: firstCommitment,
    })
    assert.equal(cooldown.code, 'self_goal_cooldown')

    for (let count = 1; count < MAX_SELF_GOALS_PER_WINDOW; count++) {
      nowMs += SELF_GOAL_CREATE_COOLDOWN_MS + 1
      const created = await store.createSelf({
        objective: `goal-${count}`, motivation: 'test', completionCriteria: ['done'], currentCommitment: firstCommitment,
      })
      assert.equal(created.code, 'created')
      await store.abandonSelf({ goalId: created.goal!.goalId, reason: 'test' })
    }
    nowMs += SELF_GOAL_CREATE_COOLDOWN_MS + 1
    const limited = await store.createSelf({
      objective: 'one too many', motivation: 'test', completionCriteria: ['done'], currentCommitment: firstCommitment,
    })
    assert.equal(limited.code, 'self_goal_daily_limit')
  })

  test('pause, budget-limited resume and clear follow owner-controlled transitions', async () => {
    const store = createInMemoryGoalStore()
    await store.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '目标', tokenBudget: 10 },
    })
    const goalId = (await store.get())!.goalId
    await store.accountRound({ goalId, tokensUsed: 12, timeUsedSeconds: 2 })
    assert.equal((await store.get())?.status, 'budget_limited')

    const refused = await store.applyControl({
      messageRowId: 2,
      command: { action: 'resume', tokenBudget: null },
    })
    assert.equal(refused.code, 'budget_increase_required')

    const resumed = await store.applyControl({
      messageRowId: 3,
      command: { action: 'resume', tokenBudget: 20 },
    })
    assert.equal(resumed.goal?.status, 'active')
    assert.equal(resumed.goal?.tokenBudget, 20)

    const paused = await store.applyControl({ messageRowId: 4, command: { action: 'pause' } })
    assert.equal(paused.goal?.status, 'paused')
    const cleared = await store.applyControl({ messageRowId: 5, command: { action: 'clear' } })
    assert.equal(cleared.goal?.status, 'cancelled')
  })

  test('same blocker must recur in three consecutive goal rounds', async () => {
    const store = createInMemoryGoalStore()
    await store.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '目标', tokenBudget: null },
    })
    const goalId = (await store.get())!.goalId
    const first = await store.reportBlocker({
      goalId, roundIndex: 1, blockerKey: 'owner_auth', reason: '缺授权',
    })
    const gap = await store.reportBlocker({
      goalId, roundIndex: 3, blockerKey: 'owner_auth', reason: '仍缺授权',
    })
    const second = await store.reportBlocker({
      goalId, roundIndex: 4, blockerKey: 'owner_auth', reason: '仍缺授权',
    })
    const third = await store.reportBlocker({
      goalId, roundIndex: 5, blockerKey: 'owner_auth', reason: '仍缺授权',
    })
    assert.equal(first.goal?.blockerTurns, 1)
    assert.equal(gap.goal?.blockerTurns, 1)
    assert.equal(second.goal?.status, 'active')
    assert.equal(third.code, 'blocked')
    assert.equal(third.goal?.status, 'blocked')
  })

  test('hard provider usage limits stop the goal until owner resume', async () => {
    const store = createInMemoryGoalStore()
    await store.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '目标', tokenBudget: null },
    })
    const goalId = (await store.get())!.goalId
    const stopped = await store.markUsageLimited({ goalId, reason: 'quota exhausted' })
    assert.equal(stopped.goal?.status, 'usage_limited')
    const resumed = await store.applyControl({
      messageRowId: 2,
      command: { action: 'resume', tokenBudget: null },
    })
    assert.equal(resumed.goal?.status, 'active')
  })

  test('blocker streak uses persistent goal rounds across BotLoop restart', async () => {
    const firstProcessStore = createInMemoryGoalStore()
    await firstProcessStore.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '等待授权', tokenBudget: null },
    })
    const goalId = (await firstProcessStore.get())!.goalId
    const firstProcessTool = createGoalTool(firstProcessStore)
    const queue = new InMemoryEventQueue<BotEvent>()
    for (const goalRoundIndex of [1, 2]) {
      await firstProcessTool.execute({
        action: 'report_blocker', goalId, blockerKey: 'owner_auth', reason: '仍缺授权',
      }, { eventQueue: queue, roundIndex: goalRoundIndex, goalRoundIndex })
      await firstProcessStore.accountRound({ goalId, tokensUsed: 0, timeUsedSeconds: 0 })
    }

    const restoredStore = createInMemoryGoalStore(await firstProcessStore.get())
    const restoredTool = createGoalTool(restoredStore)
    await restoredTool.execute({
      action: 'report_blocker', goalId, blockerKey: 'owner_auth', reason: '重启后仍缺授权',
    }, {
      eventQueue: queue,
      roundIndex: 1,
      goalRoundIndex: (await restoredStore.get())!.roundsUsed + 1,
    })

    assert.equal((await restoredStore.get())?.roundsUsed, 2)
    assert.equal((await restoredStore.get())?.status, 'blocked')
  })

  test('goal tool reads state and records completion evidence', async () => {
    const store = createInMemoryGoalStore()
    await store.applyControl({
      messageRowId: 1,
      command: { action: 'set', objective: '目标', tokenBudget: null },
    })
    const goal = (await store.get())!
    const tool = createGoalTool(store)
    const context = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 8 }
    const getResult = await tool.execute({ action: 'get' }, context)
    assert.match(String(getResult.content), new RegExp(goal.goalId))
    assert.equal(getResult.outcome?.progress, false)
    assert.equal(getResult.outcome?.continuation, 'immediate')
    assert.match(getResult.outcome?.noveltyKey ?? '', new RegExp(`^goal:${goal.goalId}:`))

    const replanned = await tool.execute({
      action: 'replan',
      goalId: goal.goalId,
      currentCommitment: firstCommitment,
    }, context)
    assert.equal(replanned.outcome?.ok, true)
    assert.deepEqual((await store.get())?.currentCommitment, firstCommitment)

    const completed = await tool.execute({
      action: 'complete',
      goalId: goal.goalId,
      evidence: ['pnpm build exit 0', '目标文件已检查'],
    }, context)
    assert.equal(completed.outcome?.ok, true)
    assert.match(String(completed.content), /注意力重新自由/)
    assert.equal((await store.get())?.status, 'complete')
    assert.equal((await store.get())?.currentCommitment, null)
    assert.deepEqual((await store.get())?.completionEvidence, ['pnpm build exit 0', '目标文件已检查'])
  })

  test('goal tool exposes create_self and abandon_self actions', async () => {
    const store = createInMemoryGoalStore()
    const tool = createGoalTool(store)
    const context = { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
    assert.equal(tool.schema.safeParse({
      action: 'create_self',
      objective: '缺少当前承诺的目标',
      motivation: '验证 schema',
      completionCriteria: ['完成'],
    }).success, false)
    const created = await tool.execute({
      action: 'create_self',
      objective: '自己维护一个长期研究方向',
      motivation: '这个问题会跨多轮产生新证据',
      completionCriteria: ['完成初始结论', '记录失效条件'],
      currentCommitment: firstCommitment,
      tokenBudget: 2_000_000,
    }, context)
    assert.equal(created.outcome?.ok, true)
    const goal = (await store.get())!
    assert.equal(goal.origin, 'self')
    assert.equal(goal.tokenBudget, 2_000_000)
    assert.deepEqual(goal.currentCommitment, firstCommitment)

    const replannedCommitment = {
      action: '寻找一条反证并核对原始出处',
      reason: '初始结论已经形成，下一步需要主动证伪',
      expectedEvidence: '一条反证及其原始来源',
    }
    const replanned = await tool.execute({
      action: 'replan',
      goalId: goal.goalId,
      currentCommitment: replannedCommitment,
    }, context)
    assert.equal(replanned.outcome?.ok, true)
    assert.equal(replanned.outcome?.progress, true)
    assert.equal(replanned.outcome?.continuation, 'immediate')
    assert.deepEqual((await store.get())?.currentCommitment, replannedCommitment)

    const abandoned = await tool.execute({
      action: 'abandon_self',
      goalId: goal.goalId,
      reason: '研究对象已经消失',
    }, context)
    assert.equal(abandoned.outcome?.ok, true)
    assert.equal((await store.get())?.status, 'abandoned')
  })

  test('replays missed owner-private goal commands in message-row order', async () => {
    const originalFindMany = prisma.message.findMany
    let query: unknown
    ;(prisma.message as unknown as { findMany: (args: unknown) => Promise<unknown[]> }).findMany = async (args) => {
      query = args
      return [
        {
          id: 11, senderId: 100n, sceneExternalId: '100',
          searchText: '/goal 完成离线恢复', resolvedText: '/goal 完成离线恢复',
        },
        {
          id: 12, senderId: 100n, sceneExternalId: '100',
          searchText: '/goal pause', resolvedText: '/goal pause',
        },
      ]
    }
    try {
      const store = createInMemoryGoalStore()
      const result = await replayOwnerGoalCommands({
        owner: { qq: 100, name: 'owner' },
        mailboxCursors: { 'qq_private:100': 10 },
        legacyLastWakeAt: null,
        goalStore: store,
      })

      assert.deepEqual(result, { matched: 2, handled: 2 })
      assert.equal((await store.get())?.objective, '完成离线恢复')
      assert.equal((await store.get())?.status, 'paused')
      assert.equal(
        (query as { where: { id: { gt: number } } }).where.id.gt,
        10,
      )
    } finally {
      ;(prisma.message as unknown as { findMany: typeof originalFindMany }).findMany = originalFindMany
    }
  })

  test('buffers live startup controls until replay has established row order', async () => {
    const processed: number[] = []
    const gate = createStartupGoalControlGate<{ messageRowId: number }>(async (event) => {
      processed.push(event.messageRowId)
    })

    await gate.submit({ messageRowId: 13 })
    await gate.submit({ messageRowId: 11 })
    assert.deepEqual(processed, [])
    await gate.finishReplay()
    await gate.submit({ messageRowId: 14 })

    assert.deepEqual(processed, [11, 13, 14])
  })
})
