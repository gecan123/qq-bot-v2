# Agent Short-Term Schedule Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将现有一次性 `schedule` 升级为有 3 天硬边界、支持 `at` / `every` / `cron`、可跨重启恢复的 Agent 短期调度能力，让到期事件只唤醒 Agent 重新判断下一步。

**Architecture:** 使用独立、版本化的 JSON store 保存最多 20 个活跃 schedule；同一 Node.js 进程内的 `ScheduleRuntime` 为每个任务维护一个 timer，到期后先持久化状态，再向现有事件队列写入 `scheduled_wake`。工具只负责 create/list/cancel，不保存未来工具调用；Agent 被唤醒后基于最新 Goal、消息和环境重新决策。

**Tech Stack:** TypeScript、Zod、Croner、Node.js timers、atomic JSON persistence、`node:test`

---

设计依据见 `docs/plans/2026-07-13-agent-schedule-design.md`。实现期间遵守以下固定边界：

- 一次性任务只能安排在 30 秒至 3 天内。
- 周期任务相邻两次触发至少间隔 5 分钟，且创建 3 天后强制过期。
- 最多 20 个活跃任务；同名且同定义幂等，同名不同定义报冲突。
- timer callback 只能更新调度状态并写入事件队列，不能直接调用 LLM 或工具。
- 不迁移旧 background task recovery 里的 schedule；该能力此前没有实际使用数据。
- 不启动真实 QQ、NapCat、浏览器、数据库或长期驻留 Bot 进程。

### Task 1: 建立调度时间模型

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/agent/schedule-model.ts`
- Test: `src/agent/schedule-model.test.ts`

**Step 1: 添加 Croner 依赖**

Run:

```bash
pnpm add croner
```

Expected: `package.json` 和 `pnpm-lock.yaml` 仅增加 Croner 相关依赖。

**Step 2: 先写时间模型失败测试**

覆盖：

- `at.at` 和 `at.afterSeconds` 归一化为绝对时间。
- 少于 30 秒、超过 3 天、无效 ISO 时间均拒绝。
- `everySeconds` 少于 300 秒拒绝；`anchorAt` 决定固定节拍。
- cron 默认 `Asia/Shanghai`，无效表达式或时区拒绝。
- cron 在未来 3 天内相邻两次触发不得小于 5 分钟。
- `computeNextRunAt` 对 every/cron 都返回严格晚于参考时间的触发点。
- 所有计算基于注入的 `now`，不直接读取系统时间。

建议公开的核心类型与函数：

```ts
export const SCHEDULE_LIMITS = {
  minAtDelayMs: 30_000,
  maxLifetimeMs: 3 * 24 * 60 * 60 * 1_000,
  minRecurringIntervalMs: 5 * 60 * 1_000,
  maxActiveSchedules: 20,
} as const;

export type ScheduleSpec =
  | { kind: "at"; at: string }
  | { kind: "every"; everySeconds: number; anchorAt: string }
  | { kind: "cron"; expression: string; timezone: string };

export function normalizeScheduleSpec(
  input: unknown,
  now: Date,
): ScheduleSpec;

export function computeNextRunAt(
  schedule: ScheduleSpec,
  after: Date,
): Date | null;
```

**Step 3: 运行测试确认失败**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/schedule-model.test.ts
```

Expected: FAIL，原因是实现文件或导出尚不存在。

**Step 4: 实现最小时间模型**

- 用 Zod 验证输入结构和互斥字段。
- Croner 只用于解析和计算 cron 下一次时间，使用 paused 模式，不让它创建 timer。
- 通过连续计算至少两个触发点验证 cron 最小间隔。
- 归一化结果保存明确的 timezone 和 anchor，不保留相对时间输入。
- 错误包含稳定的机器可判断 code，例如 `invalid_schedule`、`outside_schedule_window`、`recurrence_too_frequent`。

**Step 5: 运行测试确认通过**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/schedule-model.test.ts
```

Expected: PASS。

**Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml src/agent/schedule-model.ts src/agent/schedule-model.test.ts
git commit -m "feat: 增加短期调度时间模型"
```

### Task 2: 建立版本化持久化存储

**Files:**

- Create: `src/agent/schedule-store.ts`
- Test: `src/agent/schedule-store.test.ts`

**Step 1: 先写 store 失败测试**

定义持久化记录：

```ts
export interface ScheduleJob {
  id: string;
  name: string;
  intention: string;
  schedule: ScheduleSpec;
  createdAt: string;
  expiresAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  runCount: number;
  maxRuns?: number;
}
```

覆盖：

- 文件不存在时返回空集合。
- 读写 `{ version: 1, schedules: [...] }` 可往返。
- 写入使用同目录临时文件再 rename，成功后不残留 temp。
- 损坏 JSON、未知 version、非法 job 明确失败，不能静默视为空。
- 内存 store 与文件 store 遵循相同接口，便于 runtime 测试。
- 返回值为副本，调用方不能绕过 store 修改内部状态。

建议接口：

```ts
export interface ScheduleStore {
  load(): Promise<ScheduleJob[]>;
  replace(schedules: readonly ScheduleJob[]): Promise<void>;
}
```

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/schedule-store.test.ts
```

Expected: FAIL，原因是 store 未实现。

**Step 3: 实现 store**

- Zod schema 是磁盘格式的事实来源。
- 文件 store 在构造时只保存 path，`load()` 时读取并验证。
- `replace()` 创建父目录，写入随机后缀临时文件，再原子 rename。
- 写入失败时尽力删除本次临时文件，但不得破坏原文件。
- 不添加旧格式兼容层或 background-task migration。

**Step 4: 运行测试确认通过**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/schedule-store.test.ts
```

Expected: PASS。

**Step 5: 提交**

```bash
git add src/agent/schedule-store.ts src/agent/schedule-store.test.ts
git commit -m "feat: 增加短期调度持久存储"
```

### Task 3: 扩展 scheduled_wake 事件契约

**Files:**

- Modify: `src/agent/event.ts`
- Modify: `src/agent/render-event.ts`
- Modify: `src/agent/render-event.test.ts`

**Step 1: 修改测试表达新事件**

将现有 `reason` / `dueAt` 断言改为：

```ts
{
  type: "scheduled_wake",
  scheduleId: "schedule-1",
  name: "检查任务进展",
  scheduleKind: "at",
  scheduledFor: new Date("2026-07-13T08:00:00.000Z"),
  intention: "检查当前 Goal 和新消息，再判断是否继续",
  runCount: 1,
}
```

渲染给 LLM 的 JSON 使用：

```json
{
  "event": "scheduled_wake",
  "scheduleId": "schedule-1",
  "name": "检查任务进展",
  "scheduleKind": "at",
  "scheduledFor": "2026-07-13T16:00:00+08:00",
  "intention": "检查当前 Goal 和新消息，再判断是否继续",
  "runCount": 1
}
```

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/render-event.test.ts
```

Expected: FAIL，旧事件类型和渲染器尚未更新。

**Step 3: 更新事件类型和渲染**

- `scheduleKind` 仅允许 `at | every | cron`。
- 使用现有 `formatBeijingIso` 输出 `scheduledFor`。
- 保持 JSON 字段稳定，不附加动态 schedule 列表或执行指令。

**Step 4: 运行测试确认通过**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/render-event.test.ts
```

Expected: PASS。

**Step 5: 提交**

```bash
git add src/agent/event.ts src/agent/render-event.ts src/agent/render-event.test.ts
git commit -m "refactor: 扩展定时唤醒事件契约"
```

### Task 4: 实现 ScheduleRuntime

**Files:**

- Create: `src/agent/schedule-runtime.ts`
- Test: `src/agent/schedule-runtime.test.ts`

**Step 1: 用 fake clock/timer 写创建与取消测试**

覆盖：

- `start()` 加载 store，清理过期 job，并为未来 job 建立 timer。
- create 先成功持久化，再把 job 放入内存并 arm timer。
- 同名同定义返回 `existing`，不重复创建。
- 同名不同定义返回 `name_conflict`，不修改状态。
- 第 21 个活跃任务返回 `active_limit_reached`。
- cancel 删除并持久化；重复 cancel 返回 `already_absent`。
- `stop()` 清除所有 timer，且不删除持久化 job。

注入以下依赖，禁止测试等待真实时间：

```ts
interface ScheduleRuntimeDeps {
  store: ScheduleStore;
  eventQueue: AgentEventQueue;
  now?: () => Date;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  createId?: () => string;
  logger?: Pick<Console, "error" | "warn">;
}
```

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/schedule-runtime.test.ts
```

Expected: FAIL，runtime 尚不存在。

**Step 3: 实现生命周期和 CRUD**

- runtime 内存中只保存活跃 job 和 timer handle。
- 对 create/cancel/fire 使用一个内部 mutation queue 或 mutex 串行化，避免读改写覆盖。
- 所有 create 校验在写 store 前完成。
- store 写失败时保持内存与 timer 不变，并把错误返回给调用方。
- `list()` 按 `nextRunAt`、`createdAt` 稳定排序。

**Step 4: 写触发与重启恢复失败测试**

覆盖：

- at 到期：持久化删除后 enqueue 一次事件。
- every/cron：`runCount + 1`、写 `lastRunAt`、按 anchor/cron 计算下一次，不能按 callback 实际执行时间漂移。
- 达到 `maxRuns` 或下一次超过 `expiresAt` 时删除。
- 重启后未来任务正常重设 timer。
- 未过期但 overdue 的 at 只补发一次。
- recurring 错过多个 tick 只合并为一次 wake，再推进到第一个未来 tick。
- 已过期任务清理且不 wake。
- 同一次 fire 的 store 写失败时不 enqueue，记录错误并安排有界 retry。
- enqueue 抛错不会回滚已提交的 run 状态；记录错误，避免重复执行同一 tick。

**Step 5: 实现触发与恢复**

- timer callback 仅调用 runtime 内部 fire 流程。
- `scheduledFor` 是原计划时间，不是 callback 实际运行时间。
- fire 先持久化新的 schedules 集合，再更新内存/timer，最后 enqueue。
- 持久化失败使用短延迟重试检查；`stop()` 后不得继续重试。
- 任何 timer delay 超出 Node 上限时按上限分段 re-arm；虽然当前 3 天不会触发，也保持实现安全。

**Step 6: 运行测试确认通过**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/schedule-runtime.test.ts
```

Expected: PASS，且测试无真实 sleep。

**Step 7: 提交**

```bash
git add src/agent/schedule-runtime.ts src/agent/schedule-runtime.test.ts
git commit -m "feat: 增加短期调度运行时"
```

### Task 5: 将 schedule 工具升级为 create/list/cancel

**Files:**

- Modify: `src/agent/tools/schedule.ts`
- Modify: `src/agent/tools/schedule.test.ts`
- Modify: `src/agent/tools/tool-concurrency.test.ts`

**Step 1: 先改工具测试**

create 输入 schema：

```ts
{
  action: "create",
  name: string,
  intention: string,
  schedule:
    | { kind: "at", at: string }
    | { kind: "at", afterSeconds: number }
    | { kind: "every", everySeconds: number, anchorAt?: string }
    | { kind: "cron", expression: string, timezone?: string },
  maxRuns?: number
}
```

另有：

```ts
{ action: "list" }
{ action: "cancel", id: string }
```

覆盖：

- create/list/cancel 调用 runtime 对应方法。
- 结构错误、空 name/intention、at 两种时间同时出现、非法 maxRuns 在 tool boundary 失败。
- 返回结果包含稳定 status：`created`、`existing`、`cancelled`、`already_absent`。
- list 只返回活跃任务的有界结构。
- 只有 list 标记为 parallel-safe；create/cancel 保持串行副作用语义。
- 工具描述明确“到期只唤醒重新判断，不会保存或直接执行未来工具调用”。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/schedule.test.ts src/agent/tools/tool-concurrency.test.ts
```

Expected: FAIL，现有工具仍是一次性 `delay_seconds/reason`。

**Step 3: 实现工具适配**

- 工具不自行计算时间或读写文件，统一委托 `ScheduleRuntime`。
- 将 runtime 的领域错误转换为简短、可操作的 tool result。
- list 输出 `id/name/intention/schedule/nextRunAt/expiresAt/runCount/maxRuns`，不泄漏内部 timer。
- 删除旧 background task recovery descriptor 写入逻辑。

**Step 4: 运行测试确认通过**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/schedule.test.ts src/agent/tools/tool-concurrency.test.ts
```

Expected: PASS。

**Step 5: 提交**

```bash
git add src/agent/tools/schedule.ts src/agent/tools/schedule.test.ts src/agent/tools/tool-concurrency.test.ts
git commit -m "feat: 升级Agent短期调度工具"
```

### Task 6: 接入 AgentRuntime 并删除旧 scheduler

**Files:**

- Modify: `src/config/index.ts`
- Modify: `src/config/index.test.ts`
- Modify: `.env.example`
- Modify: `src/index.ts`
- Modify: `src/agent/runtime.ts`
- Modify: `src/agent/runtime.test.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/tools/index.test.ts`
- Modify: `src/agent/background-task-registry.test.ts`
- Delete: `src/agent/durable-wake-scheduler.ts`
- Delete: `src/agent/durable-wake-scheduler.test.ts`

**Step 1: 先写配置与集成失败测试**

覆盖：

- config 默认 `scheduleStatePath` 为 `data/agent-workspace/runtime/schedules.json`。
- `BOT_SCHEDULE_STATE_PATH` 可覆盖路径。
- runtime 未注入 schedule runtime 时创建内存 store，保证单测与临时 runtime 不写 workspace。
- production entry 显式传入配置路径，创建持久化 store。
- schedule 工具仍为 always-on。
- runtime 启动时调用 `ScheduleRuntime.start()`，停止 background services 时调用 `stop()`。
- tool registry 依赖从 `wakeScheduler` 改为 `scheduleRuntime`。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/config/index.test.ts src/agent/runtime.test.ts src/agent/tools/index.test.ts
```

Expected: FAIL，配置和依赖注入仍指向旧 scheduler。

**Step 3: 完成 runtime 接线**

- `AgentRuntimeInput` 支持测试注入 `scheduleRuntime`，也支持 production 传 `scheduleStatePath`。
- 默认构造路径使用现有 event queue；不要新建线程、worker、子进程或轮询循环。
- 初始化 store 失败要让 runtime 启动明确失败，不能静默丢弃 schedules。
- stop 顺序先停止调度 timer，再停止其余后台服务。
- 从工具注册与 runtime 中移除 `DurableWakeScheduler`。
- 删除旧 scheduler 文件及其测试。
- background registry 的通用 recovery 字段暂时保留，避免扩大到无关重构；将 schedule 专属测试命名/fixture 改成通用 durable task。
- `.env.example` 增加新路径，旧 background task 路径仍服务其他 background task。

**Step 4: 运行集成测试**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/config/index.test.ts src/agent/runtime.test.ts src/agent/tools/index.test.ts src/agent/background-task-registry.test.ts
```

Expected: PASS。

**Step 5: 搜索旧 scheduler 引用**

Run:

```bash
rg "DurableWakeScheduler|durable-wake-scheduler|wakeScheduler|delay_seconds" src .env.example docs
```

Expected: 源码无旧 scheduler/tool schema 引用；docs 命中留到 Task 7 更新。

**Step 6: 提交**

```bash
git add .env.example src/config/index.ts src/config/index.test.ts src/index.ts src/agent/runtime.ts src/agent/runtime.test.ts src/agent/tools/index.ts src/agent/tools/index.test.ts src/agent/background-task-registry.test.ts src/agent/durable-wake-scheduler.ts src/agent/durable-wake-scheduler.test.ts
git commit -m "refactor: 接入短期调度运行时"
```

### Task 7: 加入 Agent 使用引导和优先级验证

**Files:**

- Modify: `prompts/bot-system.md`
- Modify: `src/agent/bot-system-prompt.test.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`
- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/TOOLS.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/HARNESS_COMPARISON.md`

**Step 1: 先写 prompt 与事件优先级失败测试**

prompt 测试应锁定一个静态 `[短期调度]` 段落，位于 `[自主生活]` 之后，并包含以下语义：

- `at` 用于明确的一次性回看；`every` 用于短期固定节奏；`cron` 用于短期日历节奏。
- `pause` 仍只表示当前短休息，不代替未来唤醒。
- schedule 不能用于等待某个人回复、轮询消息，或机械刷新网站/市场。
- 创建前先 list，避免重复 schedule。
- wake 是注意力提示，不是必须执行的命令。
- 唤醒后根据最新 Goal、消息和环境选择行动、取消或结束，不盲目续订。
- todo / schedule / goal / Agenda / pause 的职责边界清晰。

bot loop 测试覆盖：

- `scheduled_wake` 会结束 pause/rest 状态并进入 attention path。
- 已排队的高优先级 QQ 消息先于 scheduled wake 处理。
- scheduled wake 高于默认 Goal 驱动或自由活动，但不绕过现有高优先级消息。

**Step 2: 运行测试确认失败**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/bot-system-prompt.test.ts src/agent/bot-loop-agent.test.ts
```

Expected: FAIL，prompt 尚未加入新契约，必要的优先级断言尚未满足或尚未固定。

**Step 3: 更新 prompt**

在不动态注入 schedule 列表的前提下加入简短静态说明。不要把完整工具 schema 重复塞入 system prompt；具体字段由 tool description 渐进披露。

**Step 4: 补充或调整事件优先级**

- 优先复用现有 attention event 分类与队列优先级。
- 只有测试证明现状不符合设计时才改生产逻辑。
- 不让 scheduled wake 抢占已经到达的高优先级 QQ 消息。

**Step 5: 更新专题文档**

- `AGENT_CONTEXT.md`：记录 scheduled wake 的稳定事件字段和“只唤醒、重新判断”不变量。
- `ARCHITECTURE.md`：说明同进程 `ScheduleRuntime`、独立 store、无后台线程。
- `TOOLS.md`：记录 create/list/cancel、三种 schedule 和全部硬边界。
- `OPERATIONS.md`：记录 `BOT_SCHEDULE_STATE_PATH`、重启恢复、损坏 store 的显式失败方式。
- `HARNESS_COMPARISON.md`：移除“仅一次性 30 秒到 7 天”的旧描述，改成当前短期模型。
- 不把频繁变化的实现细节或完整文件地图写入 `AGENTS.md` / `CLAUDE.md`。

**Step 6: 运行 focused tests 和文档检查**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/bot-system-prompt.test.ts src/agent/bot-loop-agent.test.ts src/agent/render-event.test.ts
pnpm repo-check
```

Expected: 全部 PASS，且 `AGENTS.md` / `CLAUDE.md` 仍字节级一致。

**Step 7: 提交**

```bash
git add prompts/bot-system.md src/agent/bot-system-prompt.test.ts src/agent/bot-loop-agent.test.ts docs/AGENT_CONTEXT.md docs/ARCHITECTURE.md docs/TOOLS.md docs/OPERATIONS.md docs/HARNESS_COMPARISON.md
git commit -m "feat: 引导Agent使用短期调度"
```

### Task 8: 全量验证和收尾

**Files:**

- Verify only; only modify files if verification reveals a scoped defect.

**Step 1: 运行 schedule focused suite**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/schedule-model.test.ts src/agent/schedule-store.test.ts src/agent/schedule-runtime.test.ts src/agent/tools/schedule.test.ts src/agent/render-event.test.ts src/agent/runtime.test.ts
```

Expected: PASS。

**Step 2: 运行静态检查**

Run:

```bash
pnpm typecheck
pnpm repo-check
```

Expected: PASS。

**Step 3: 运行全量测试**

Run:

```bash
pnpm test
```

Expected: PASS。不得以启动真实 Bot 作为验证手段。

**Step 4: 检查旧契约和 diff**

Run:

```bash
rg "DurableWakeScheduler|durable-wake-scheduler|wakeScheduler|delay_seconds|30 秒到 7 天|30s.*7d" src prompts docs .env.example
git diff --check
git status --short
```

Expected:

- 没有旧 schedule 实现或说明残留。
- `git diff --check` 无输出。
- 工作树只包含本次任务预期内容；已有未跟踪 `docs/plans/2026-07-13-architecture-doc-sync.md` 保持未修改、未暂存。

**Step 5: 若验证导致补丁，单独提交**

```bash
git add <only-the-files-fixed-during-verification>
git commit -m "fix: 完善短期调度边界处理"
```

如果无需补丁，不创建空提交。
