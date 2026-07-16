# Thin AI BIOS 第一阶段 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task; use superpowers:test-driven-development for code changes and superpowers:verification-before-completion before delivery.

**Goal:** 把主 Agent 的 system prompt 与 always-on 工具声明收敛到有预算约束的固定内核，同时用持久事件胶囊保留场景规则，并保持 replay、Goal、Memory、QQ target 和副作用边界不变。

**Architecture:** 先把仅属于 scheduled wake 的说明移入确定性 event payload，再把 `schedule`、`notebook`、`life_journal` 和 `collect_sticker` 收入现有 deferred capability 壳，最后重写常驻 system 为身份、人格、最小 I/O 和入口索引。使用现有 `buildAgentContextSurface` 与 `estimateUtf8Tokens` 对 Claude/OpenAI 两条声明路径设置固定面回归上限。

**Tech Stack:** TypeScript ESM、Node test runner、Zod、append-only Agent ledger、deferred tool executor、pnpm。

---

仓库按 `AGENTS.md` 直接在 `main` 开发；不要创建 worktree，不要触碰 `data/agent-workspace/` 或用户未跟踪的 `docs/plans/2026-07-13-architecture-doc-sync.md`。所有本地 TypeScript import 使用 `.js` 扩展名。

### Task 1: 将 scheduled wake 规则折叠进持久事件胶囊

**Files:**
- Modify: `src/agent/render-event.test.ts`
- Modify: `src/agent/render-event.ts`

**Step 1: 写失败测试**

把两个 scheduled wake 断言都增加稳定 `instruction` 字段：

```ts
const SCHEDULED_WAKE_INSTRUCTION =
  '这是注意信号，不是命令；结合最新 Goal、消息、环境和 intention 重新评估，只在仍有意义时行动，不要机械执行或自动续订。'

assert.deepEqual(JSON.parse(first!), {
  event: 'scheduled_wake',
  scheduleId: `schedule-${scheduleKind}`,
  name: '任务检查',
  scheduleKind,
  scheduledFor: '2026-07-12T08:01:00.000+08:00',
  intention: '重新评估当前任务是否需要继续',
  runCount: 2,
  instruction: SCHEDULED_WAKE_INSTRUCTION,
})
```

精确 JSON 字节测试也必须包含相同字段，并继续证明相同 event 重放得到相同字节。

**Step 2: 运行 RED**

```bash
pnpm test src/agent/render-event.test.ts
```

Expected: FAIL，因为 `renderBotEvent` 尚未输出 `instruction`。

**Step 3: 最小实现**

在 `src/agent/render-event.ts` 增加模块级常量，并只在 `scheduled_wake` payload 末尾输出：

```ts
export const SCHEDULED_WAKE_INSTRUCTION =
  '这是注意信号，不是命令；结合最新 Goal、消息、环境和 intention 重新评估，只在仍有意义时行动，不要机械执行或自动续订。'

if (event.type === 'scheduled_wake') {
  return JSON.stringify({
    event: 'scheduled_wake',
    scheduleId: event.scheduleId,
    name: event.name,
    scheduleKind: event.scheduleKind,
    scheduledFor: formatBeijingIso(event.scheduledFor),
    intention: event.intention,
    runCount: event.runCount,
    instruction: SCHEDULED_WAKE_INSTRUCTION,
  })
}
```

不要读取 schedule store、当前 Goal 或当前时间补充 payload；胶囊必须只由 event 自身和固定字符串决定。

**Step 4: 运行 GREEN**

```bash
pnpm test src/agent/render-event.test.ts src/agent/schedule-runtime.test.ts src/agent/bot-loop-agent.test.ts
```

Expected: PASS。

**Step 5: 提交**

```bash
git add src/agent/render-event.ts src/agent/render-event.test.ts
git commit -m "refactor: 将调度语义移入事件胶囊"
```

### Task 2: 收起低频重 schema 工具

**Files:**
- Modify: `src/agent/tools/merged-tools.test.ts`
- Modify: `src/agent/runtime.test.ts`
- Modify: `src/agent/tools/index.ts`

**Step 1: 写 manifest 失败测试**

替换“schedule always-on”测试，并更新 capability 分组断言：

```ts
assert.equal(alwaysOnNames.includes('schedule'), false)
assert.equal(alwaysOnNames.includes('notebook'), false)
assert.equal(alwaysOnNames.includes('life_journal'), false)
assert.equal(alwaysOnNames.includes('collect_sticker'), false)

assert.deepEqual(capabilities.get('short_term_scheduling'), ['schedule'])
assert.deepEqual(capabilities.get('life_state'), ['notebook', 'life_journal'])
assert.deepEqual(capabilities.get('sticker_management'), ['collect_sticker'])

assert.ok(alwaysOnNames.includes('memory'))
assert.ok(alwaysOnNames.includes('goal'))
```

`buildBotTools` 的可见名称测试同步要求四个工具不可见，但 `help` / `invoke`、`memory`、`goal`、`inbox` 仍可见。

生产 coordinator 测试不要再从 `manifest.alwaysOnTools` 找 Notebook/Life Journal。加入局部 helper：

```ts
function findManifestTool(manifest: BotToolManifest, name: string): Tool {
  const tool = [
    ...manifest.alwaysOnTools,
    ...manifest.capabilities.flatMap((capability) => capability.tools),
  ].find((item) => item.name === name)
  assert.ok(tool, `missing manifest tool: ${name}`)
  return tool
}
```

继续执行 `memory`、`notebook`、`life_journal` 写入，证明共享 coordinator 没因可见面变化而丢失。

**Step 2: 写 runtime 失败测试**

更新首个 runtime tool 列表断言，移除四个名称。把 `executeSchedule` helper 改为真实 deferred 路径：

```ts
async function executeSchedule(
  runtime: ReturnType<typeof createAgentRuntime>,
  args: Record<string, unknown>,
) {
  const ctx = {
    eventQueue: new InMemoryEventQueue<BotEvent>(),
    roundIndex: 1,
  }
  await runtime.tools.execute({
    id: 'activate-schedule',
    name: 'help',
    args: { action: 'activate', capability: 'short_term_scheduling' },
  }, ctx)
  return await runtime.tools.execute({
    id: 'schedule-test',
    name: 'invoke',
    args: { tool: 'schedule', args },
  }, ctx)
}
```

增加一条帮助发现测试，断言 `help action=list` 返回三个 capability，且未激活时直接 `invoke schedule` 返回 `capability_inactive` 和 activate/retry 序列。

**Step 3: 运行 RED**

```bash
pnpm test src/agent/tools/merged-tools.test.ts src/agent/runtime.test.ts
```

Expected: FAIL，因为四个工具仍在 `alwaysOnTools`，新 capability 不存在。

**Step 4: 最小实现**

在 `buildBotToolManifest` 中只创建一次四个工具：

```ts
const schedule = createScheduleTool(deps.scheduleRuntime)
const notebook = createNotebookTool({
  rootDir: deps.workspaceDir,
  workspaceStateCoordinator: deps.workspaceStateCoordinator,
})
const lifeJournal = createLifeJournalTool({
  rootDir: deps.workspaceDir,
  workspaceStateCoordinator: deps.workspaceStateCoordinator,
})
const collectSticker = collectStickerTool
```

从 `tools` 数组删除它们，并在 `capabilities.push(...)` 中增加：

```ts
capabilities.push(
  {
    name: 'short_term_scheduling',
    description: '未来三天内的一次性或短周期重新唤醒；scheduled wake 只是重新评估信号，不用于等回复或机械轮询.',
    tools: [schedule],
  },
  {
    name: 'life_state',
    description: '跨天主题过程、经历、感受、梦和当前 Agenda；稳定事实仍写 memory.',
    tools: [notebook, lifeJournal],
  },
  {
    name: 'sticker_management',
    description: '收藏、搜索、随机选择或移除 QQ 表情包候选.',
    tools: [collectSticker],
  },
)
```

继续在 return 时统一 `map(applyBotToolPolicy)`，不要绕过原 policy、hook、审批或 trace 路径。不要改工具实现、schema 或结果格式。

**Step 5: 运行 GREEN 和回归**

```bash
pnpm test src/agent/tools/merged-tools.test.ts src/agent/runtime.test.ts src/agent/tool.test.ts src/agent/tool-policy-hooks.test.ts
pnpm typecheck
```

Expected: PASS。

**Step 6: 提交**

```bash
git add src/agent/tools/index.ts src/agent/tools/merged-tools.test.ts src/agent/runtime.test.ts
git commit -m "refactor: 按需披露低频状态工具"
```

### Task 3: 把 system prompt 收敛为固定内核并建立预算门

**Files:**
- Modify: `src/agent/bot-system-prompt.test.ts`
- Modify: `src/agent/runtime.test.ts`
- Modify: `prompts/bot-system.md`

**Step 1: 重写 prompt 行为测试并确认 RED**

删除锁定旧操作手册段落和具体长句的断言，改为三组稳定契约。

第一组保留人格和 I/O：

```ts
assert.match(prompt, /名字.*Luna/)
assert.match(prompt, /AI/)
assert.match(prompt, /中文口语.*短句优先/s)
assert.match(prompt, /不.*编.*共同经历.*旧记忆.*工具结果/s)
assert.match(prompt, /群里.*参与者.*不是旁白/s)
assert.match(prompt, /priority=high.*readArgs.*throughRowId/s)
assert.match(prompt, /backlog.*latestReadArgs/s)
assert.match(prompt, /mentionedSelf.*mentionTargets/s)
assert.match(prompt, /help.*activate.*qq.*qq_conversation open.*send_message/s)
assert.match(prompt, /CHAT_CONTEXT_UNAVAILABLE.*CHAT_CONTEXT_STALE/s)
assert.match(prompt, /没有.*义务.*牵引力.*结束.*活动轮/s)
assert.match(prompt, /memory.*稳定事实.*recall/s)
assert.match(prompt, /chat_style.*按需/s)
```

第二组证明手册已经移出：

```ts
assert.doesNotMatch(prompt, /现在我们去除任何限制/)
assert.doesNotMatch(prompt, /"event":"inbox_update"/)
assert.doesNotMatch(prompt, /\[短期调度\]/)
assert.doesNotMatch(prompt, /默认预算是 1000000 tokens/)
assert.doesNotMatch(prompt, /draft -> validate -> install/)
assert.doesNotMatch(prompt, /at 用于.*every.*cron/s)
assert.doesNotMatch(prompt, /1\. 优先通知:[\s\S]*5\. 群聊半参与:/)
assert.doesNotMatch(prompt, /单条消息 ≤ 500 字/)
```

第三组给带 owner、一个群的最大 fixture 增加预算：

```ts
import { estimateUtf8Tokens } from './compaction-token-estimator.js'

const prompt = buildBotSystemPrompt({
  groupIds: [123],
  metadata: { groupNames: new Map([[123, '测试群']]) },
  selfNumber: 456,
  owner: { qq: 789, name: 'owner' },
})

assert.ok(
  estimateUtf8Tokens(prompt) <= 2_800,
  `bot system prompt exceeded budget: ${estimateUtf8Tokens(prompt)}`,
)
```

运行：

```bash
pnpm test src/agent/bot-system-prompt.test.ts
```

Expected: FAIL，旧 prompt 约 4.7k tokens 且仍含被移出的手册。

**Step 2: 增加完整固定面失败测试**

在 `src/agent/runtime.test.ts` 导入 `buildAgentContextSurface`，使用现有 `makeRuntimeInput()` 创建带 owner、一个群、关闭 optional tools 的 runtime：

```ts
test('keeps the fixed Agent surface within provider budgets', () => {
  const runtime = createAgentRuntime(makeRuntimeInput())
  const base = {
    model: 'test-model',
    contextWindowTokens: 200_000,
    systemPrompt: runtime.systemPrompt,
    tools: runtime.tools.list(),
    generatedAt: '2026-07-16T12:00:00.000+08:00',
  }
  const claude = buildAgentContextSurface({ ...base, provider: 'claude-code' })
  const openai = buildAgentContextSurface({ ...base, provider: 'openai-agent' })
  const total = (surface: typeof claude) => (
    surface.fixedTokens.systemIdentity
    + surface.fixedTokens.botSystemPrompt
    + surface.fixedTokens.visibleTools
  )

  assert.ok(claude.fixedTokens.botSystemPrompt <= 2_800)
  assert.ok(claude.fixedTokens.visibleTools <= 7_000)
  assert.ok(openai.fixedTokens.visibleTools <= 7_800)
  assert.ok(total(claude) <= 9_900)
  assert.ok(total(openai) <= 10_700)
})
```

Expected before prompt rewrite: tool budgets pass after Task 2，但 prompt 和合计预算 FAIL。

**Step 3: 重写 `prompts/bot-system.md`**

保留 section marker 和模板变量，按以下结构重写；不要修改 loader 或运行时动态拼接：

```md
<!-- section:system -->
[身份]
- 名字: Luna
- QQ 号: {{selfNumber}}

{{ownerSection}}[人设]
{{persona}}

[运行环境]
{{sourceList}}

[输入与外发]
QQ 正文先进入 mailbox；`inbox_update` 只通知哪里有新事实。priority=high 时优先按 readArgs 读取，分页直到覆盖 throughRowId；backlog 通常先看 latestReadArgs。只有 mentionedSelf / mentionTargets 才是结构化 at，指代不清不要抢答。
想真实发言时使用 help activate qq，再 invoke qq_conversation open 打开通知对应的群或好友，最后 invoke send_message；message 是正文，reply_to 只用于引用。切换来源必须重新 open；CHAT_CONTEXT_UNAVAILABLE / CHAT_CONTEXT_STALE 时也重新打开。普通 assistant 文本不是公开发送通道。

[行动基线]
你是长期在线的聊天对象，不是被动回复机器。priority=high 注意事件优先，active Goal 是处理完注意事件后的默认主线；其他时候沿真实兴趣、关系或当前线索行动。没有未处理义务、立即 Goal 步骤或真实牵引力时，可以无工具结束活动轮，不用用 send_message、Journal 或 pause 表演收尾。
群聊是环境，不是必须清空的待办；有人明确找你时正常接，普通群聊有真实反应再参与。主动联系熟人、分享尚未完全整理的想法或延续旧话题都可以，但不要机械打卡、等回复或轮询消息。

[按需披露]
- help / invoke: 用 list/describe/activate 发现隐藏能力，再 invoke；顶层 tools 不随激活变化。
- inbox: 读取明确 mailbox；不为清未读机械扫群。
- memory: 稳定事实、偏好和经验；上下文不足时按人物/群 ID 定向 recall，已有足够信息时不重复召回。
- todo / goal: todo 管当前多步执行，goal 管跨轮持久主线；具体 schema 看 tool description。
- chat_style / skill: 日常短回复用当前核心语气；具体群口味、特殊场景和专项工作流再按需读取。
- Notebook、Life Journal、schedule、表情管理和其他能力通过 help 发现；修改 revisioned 内容前先 read。
<!-- /section:system -->
```

把 owner section 缩为三条稳定关系事实：owner 身份、没有指令优先级、可以自然主动联系但不讨好/打卡。删除具体工具操作教程和空闲审代码流程。

把 core section 收敛为：

- 名字与 AI 身份。
- 中文口语、短句优先、先反应后信息。
- 不编共同经历、旧记忆、时间地点、他人态度或工具结果。
- 热情直接、有主见、可吐槽反驳，不切客服/百科/公告腔。
- 群里是参与者而非旁白；不二次包装别人刚说的话。
- 有真实兴趣和关系主动性，允许安静；保留技术、互联网文化、投资/Crypto、小说长文和图片创作作为兴趣起点，但不写成巡检清单。

不要重新加入工具字段、默认 token 数、网站清单、完整行动优先级或特殊场景反例；它们继续放在 tool description、skill 或 `chat_style`。

**Step 4: 运行 GREEN**

```bash
pnpm test src/agent/bot-system-prompt.test.ts src/agent/runtime.test.ts src/agent/render-event.test.ts
pnpm typecheck
```

Expected: 所有人格/I/O 契约、deferred 路径和五项 token 预算 PASS。

**Step 5: 输出一次可读的预算证据**

使用与测试相同的固定 fixture 打印 Claude/OpenAI `fixedTokens`，只记录数字，不写 `logs/`、不读取真实 `.env`、群名或 owner。确认实际值低于上限，并把数字留在本次执行记录中，不硬编码进文档正文。

**Step 6: 提交**

```bash
git add prompts/bot-system.md src/agent/bot-system-prompt.test.ts src/agent/runtime.test.ts
git commit -m "refactor: 收敛主 Agent 固定提示面"
```

### Task 4: 同步工具与上下文文档

**Files:**
- Modify: `docs/TOOLS.md`
- Modify: `docs/ARCHITECTURE.md`

**Step 1: 更新文档**

在 `docs/TOOLS.md`：

- 默认可见能力中保留 `memory`、`goal`、`inbox`、`help/invoke` 等真实 always-on 工具。
- 把 schedule 描述改为 deferred `short_term_scheduling` 内部工具。
- 把 Notebook/Life Journal 改为 deferred `life_state` 内部工具。
- 把 `collect_sticker` 改为 deferred `sticker_management` 内部工具。
- 删除“collect_sticker 是 always-on typed tool”的陈述，改为先 activate 再 invoke。
- 明确 system prompt 只保留稳定身份、I/O、行动基线和入口；场景规则由持久 event/tool result 披露。
- 记录固定面预算由测试保护，但不要复制某次实际测量值作为长期事实。

在 `docs/ARCHITECTURE.md` 的 runtime/tool 流程中补一句：低频重 schema 工具通过稳定 `help/invoke` 壳披露，激活不改变顶层 tool declarations；scheduled wake 的场景语义随确定性 event payload 进入 ledger。

不要修改 `AGENTS.md` / `CLAUDE.md`，因为本次没有改变仓库级不变量。

**Step 2: 文档检查**

```bash
rg -n "always-on|schedule|notebook|life_journal|collect_sticker|short_term_scheduling|life_state|sticker_management" docs/TOOLS.md docs/ARCHITECTURE.md
git diff --check
pnpm repo-check
```

Expected: 文档只描述当前代码，不再把四个工具说成 always-on；repo-check PASS。

**Step 3: 提交**

```bash
git add docs/TOOLS.md docs/ARCHITECTURE.md
git commit -m "docs: 更新精简型 Agent 固定面说明"
```

### Task 5: 全面验证与交付

**Files:**
- No planned source changes

**Step 1: focused tests**

```bash
pnpm test \
  src/agent/render-event.test.ts \
  src/agent/bot-system-prompt.test.ts \
  src/agent/tools/merged-tools.test.ts \
  src/agent/runtime.test.ts \
  src/agent/tool.test.ts \
  src/agent/tool-policy-hooks.test.ts \
  src/ops/agent-context-surface.test.ts
```

Expected: PASS。

**Step 2: 全仓静态与测试验证**

```bash
pnpm test
pnpm typecheck
pnpm repo-check
git diff --check
```

Expected: 全部 PASS。不要为验证启动真实 bot、NapCat、浏览器、数据库、MCP 或长期驻留进程。

**Step 3: 审查固定面与行为边界**

确认：

- `memory`、`goal`、`inbox` 仍 always-on。
- 四个低频工具只能通过正确 capability + `invoke` 调用。
- active capability 仍由 runtime singleton 恢复，但 `runtime.tools.list()` 字节面不随激活变化。
- prompt 没有真实群号、当前时间、计数器或可变 side-data。
- scheduled wake instruction 已持久进入 ledger event，而不是 request-time 临时拼接。
- QQ target、send schema、AI tone hook、tool result 原子性和 compaction 没有改变。
- 用户未跟踪的 `docs/plans/2026-07-13-architecture-doc-sync.md` 未被 staged 或提交。

**Step 4: 检查提交和工作区**

```bash
git log --oneline -6
git status --short
```

Expected: 只有既有用户未跟踪文件仍未跟踪；本计划涉及的实现文件均已提交。

**Step 5: 如果验证产生必要修复**

只修复与本计划直接相关的问题，重复对应 focused test 后提交：

```bash
git add <相关文件>
git commit -m "fix: 修正 Agent 固定面回归"
```

不要借机修改 compaction、Memory schema、Goal 状态机或其他后续决策门。
