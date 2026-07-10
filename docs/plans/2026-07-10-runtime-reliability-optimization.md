# Runtime Reliability Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 Agent runtime 的 compaction 信息丢失、启动恢复竞态、退出一致性、辅助 LLM 阻塞与计量、测试环境耦合和 deferred trace 失真。

**Architecture:** 保留 single-context Runtime Host 和稳定 tool surface。通过显式 startup barrier、lifecycle coordinator、统一 usage operation 与依赖注入收紧边界；所有行为改动采用 focused TDD，并在每个阶段提交。

**Tech Stack:** Node.js ESM、TypeScript、node:test、Prisma/PostgreSQL、NapCat WebSocket、pnpm。

---

### Task 1: Compaction 全量摘要与立即持久化

**Files:**
- Modify: `src/agent/compaction.ts`
- Modify: `src/agent/compaction.test.ts`
- Modify: `src/agent/bot-loop-agent.ts`
- Modify: `src/agent/bot-loop-agent.test.ts`

**Step 1: 写 compaction 输入保真失败测试**

构造 10 条可压缩消息，在注入的 `summarize` 中保存 `input.history`，断言每条被切出 tail 的消息都出现在 history 中。

**Step 2: 验证测试失败**

Run:

```bash
pnpm test -- src/agent/compaction.test.ts
```

Expected: FAIL，最早的消息因固定 10% drop 缺失。

**Step 3: 删除固定比例丢弃**

让 summarizer 接收完整 `historyToSummarize`：

```ts
const historyToSummarize = splitExistingSummary(toCompress).rest
await summarize({ previousSummary, history: stripImagesForSummary(historyToSummarize) })
```

删除 `SUMMARIZER_DROP_RATIO` 和 `summarizer_input_trimmed` 分支。

**Step 4: 写 compaction 后保存失败测试**

在 `bot-loop-agent.test.ts` 中触发 compaction，断言最后一次 `saved` snapshot 与当前 context 完全一致，且包含 `[历史摘要]`。

**Step 5: 验证测试失败**

Run:

```bash
pnpm test -- src/agent/bot-loop-agent.test.ts
```

Expected: FAIL，最后保存的是 compaction 前 snapshot。

**Step 6: compaction 后立即保存**

让 `maybeCompact` 返回是否改变 context，并在 sticker 注入完成后调用统一 `saveSnapshot()` helper。

**Step 7: 验证 focused tests**

Run:

```bash
pnpm test -- src/agent/compaction.test.ts src/agent/bot-loop-agent.test.ts
```

Expected: PASS。

**Step 8: 提交**

```bash
git add src/agent/compaction.ts src/agent/compaction.test.ts src/agent/bot-loop-agent.ts src/agent/bot-loop-agent.test.ts
git commit -m "fix: 保证上下文压缩完整持久化"
```

### Task 2: 显式 replay 来源与首次 backfill barrier

**Files:**
- Modify: `src/agent/replay-missed.ts`
- Modify: `src/agent/replay-missed.test.ts`
- Modify: `src/bot/core.ts`
- Modify: `src/bot/core.test.ts` or create `src/bot/startup-backfill.test.ts`
- Modify: `src/index.ts`

**Step 1: 写 replay 显式 groupIds 测试**

测试调用 `replayMissedMessages(checkpoint, { groupIds: [672312932], ... })`，不依赖全局 config。

**Step 2: 验证测试失败**

Run: `pnpm test -- src/agent/replay-missed.test.ts`

Expected: FAIL，当前 deps 没有 `groupIds` 且实现读取全局 config。

**Step 3: 注入 monitored group IDs**

在 `ReplayMissedDeps` 增加 `groupIds: readonly number[]`，使用 `deps.groupIds.map(BigInt)`，由 `index.ts` 传入 `config.botTargetGroupIds`。

**Step 4: 写首次 backfill barrier 测试**

抽出一个可注入 NapCat/backfill 的协调器，测试首次 connect 后：

```ts
const barrier = coordinator.initialBackfillDone
resolveBackfill()
await barrier
assert.deepEqual(order, ['backfill:start', 'backfill:end'])
```

并验证重连不会替换首次 barrier。

**Step 5: 验证测试失败**

Run: `pnpm test -- src/bot/startup-backfill.test.ts`

Expected: FAIL，当前注册函数不返回 barrier。

**Step 6: 实现 barrier**

`registerNapcatHandlers` 返回 `{ initialBackfillDone, drainReady }`。首次 `meta_event.lifecycle/connect` 将所有群 backfill 的 `Promise.allSettled` 绑定到 barrier；`index.ts` 在 `connectNapcat()` 后先等待 barrier，再执行 replay。

**Step 7: 验证 focused tests并提交**

```bash
pnpm test -- src/agent/replay-missed.test.ts src/bot/startup-backfill.test.ts
git add src/agent/replay-missed.ts src/agent/replay-missed.test.ts src/bot/core.ts src/bot/startup-backfill.test.ts src/index.ts
git commit -m "fix: 串联历史补拉与启动回放"
```

### Task 3: Graceful shutdown coordinator

**Files:**
- Create: `src/ops/shutdown.ts`
- Create: `src/ops/shutdown.test.ts`
- Modify: `src/index.ts`
- Modify: `src/agent/bot-loop-agent.ts`
- Modify: `src/agent/snapshot-repo.ts` only if final-save access needs a small API extension

**Step 1: 写有序、幂等 shutdown 失败测试**

依赖使用函数注入，调用两次 `shutdown()`，断言顺序仅出现一次：

```ts
['disconnectIngress', 'stopAgent', 'awaitAgent', 'drainReady', 'stopJobs', 'saveFinal', 'disconnectDb']
```

**Step 2: 验证测试失败**

Run: `pnpm test -- src/ops/shutdown.test.ts`

Expected: FAIL，模块不存在。

**Step 3: 实现 coordinator**

`createShutdownCoordinator` 缓存第一次 shutdown Promise，逐阶段执行并用 timeout 包裹 `awaitAgent`/`drainReady`。阶段错误记录后继续，`disconnectDb` 始终最后执行。

**Step 4: 接入 composition root**

在 `index.ts` 保存 runtime、agent loop Promise、handler lifecycle；signal handler 调用 coordinator，不再直接 `process.exit`。调用 `napcat.disconnect()` 停止 ingress。

**Step 5: 验证并提交**

```bash
pnpm test -- src/ops/shutdown.test.ts src/index.test.ts
git add src/ops/shutdown.ts src/ops/shutdown.test.ts src/index.ts src/index.test.ts
git commit -m "fix: 增加有序退出流程"
```

### Task 4: Life Journal 有界调用与 usage 记录

**Files:**
- Modify: `src/agent/life-journal.ts`
- Modify: `src/agent/life-journal.test.ts`
- Modify: `src/agent/token-stats.ts`
- Modify: `src/ops/agent-observability-db.ts`

**Step 1: 写节流前置测试**

连续两次 `recordRound`，第二次位于 `minWriteIntervalMs` 内，断言 LLM 只调用一次且返回 skipped/throttled。

**Step 2: 验证测试失败**

Run: `pnpm test -- src/agent/life-journal.test.ts`

Expected: FAIL，当前第二次仍调用 LLM。

**Step 3: 将节流判断移到 LLM 前**

记录 `lastReviewAtMs`；节流窗口内直接返回 `{ ok: true, wroteJournal: false, updatedAgenda: false }`。

**Step 4: 写 timeout 和 usage 测试**

注入永不完成的 LLM Promise 和短 timeout，断言 `recordRound` 有界返回；对成功响应断言记录 `life_journal.review` usage。

**Step 5: 扩展 usage operation**

将 operation 类型扩展为：

```ts
type AgentTokenOperation = 'agent.chat' | 'compaction' | 'life_journal.review'
```

Life Journal 每次 LLM 完成后调用 `recordTokenUsage`，timeout 只记录警告。

**Step 6: 验证并提交**

```bash
pnpm test -- src/agent/life-journal.test.ts src/agent/token-usage.test.ts src/ops/agent-observability-db.test.ts
git add src/agent/life-journal.ts src/agent/life-journal.test.ts src/agent/token-stats.ts src/ops/agent-observability-db.ts
git commit -m "perf: 限制生活日志辅助推理"
```

### Task 5: 配置校验和自包含测试环境

**Files:**
- Modify: `src/config/index.ts`
- Modify: `src/config/index.test.ts`
- Create: `scripts/test-env.mjs`
- Modify: `package.json`

**Step 1: 写 QQ ID 校验失败测试**

覆盖 `SELF_NUMBER=abc|0|-1|9007199254740992` 和 group IDs 的非正/非 safe integer 输入。

**Step 2: 验证测试失败**

Run: `pnpm test -- src/config/index.test.ts`

Expected: FAIL，当前部分输入被接受。

**Step 3: 实现统一 ID parser**

增加 `parsePositiveSafeInteger(name, raw)`，`SELF_NUMBER`、owner QQ 和 ID lists 共用。

**Step 4: 增加测试 preload**

`scripts/test-env.mjs` 只在变量缺失时设置 dummy 值，并包含 replay fixture 所需群号。调整 `package.json` test script 在加载测试文件前 import preload。

**Step 5: 验证裸测试入口并提交**

```bash
env -u DATABASE_URL -u LLM_DEFAULT_PROVIDER -u BOT_TARGET_GROUP_IDS pnpm test
git add src/config/index.ts src/config/index.test.ts scripts/test-env.mjs package.json
git commit -m "test: 隔离测试运行环境"
```

### Task 6: Deferred invoke 单一最终 trace

**Files:**
- Modify: `src/agent/tool.ts`
- Modify: `src/agent/tool.test.ts`

**Step 1: 写 trace 语义失败测试**

分别调用成功、inactive、unknown 的 `invoke`，断言每次只追加一条 trace；成功记录真实内部 toolName，失败记录 `invoke` 或明确目标名且 `ok=false`。

**Step 2: 验证测试失败**

Run: `pnpm test -- src/agent/tool.test.ts`

Expected: FAIL，成功调用产生两条 trace，inactive/unknown 被记录成壳成功。

**Step 3: 实现单一 trace**

将 invoke schema 校验和 capability resolution 放到不带 trace 的内部路径，最终仅用一次 `createToolExecutor` 或一次显式 `traceToolCall` 记录真实结果。hooks 只执行一次。

**Step 4: 验证并提交**

```bash
pnpm test -- src/agent/tool.test.ts src/agent/tools/merged-tools.test.ts
git add src/agent/tool.ts src/agent/tool.test.ts
git commit -m "fix: 修正延迟工具调用观测"
```

### Task 7: 文档与 repository checks

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/AGENT_CONTEXT.md`
- Modify: `docs/TOOLS.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/HARNESS_COMPARISON.md`
- Modify: `docs/TECH_DEBT.md`
- Modify: `.env.example`
- Modify: `prisma/schema.prisma`
- Modify: `src/ops/repo-check.ts`
- Modify: `src/ops/repo-check.test.ts`
- Modify: `scripts/repo-check.ts`

**Step 1: 写 repo-check 失败测试**

覆盖：引用的 `prompts/groups.yaml.example` 不存在、`.env.example` 缺 `BOT_EVENT_DEBOUNCE_MS`/`BOT_TOKEN_USAGE_LOG_PATH`、错误的 fail-fast 文案。

**Step 2: 验证测试失败**

Run: `pnpm test -- src/ops/repo-check.test.ts`

Expected: FAIL 或新断言无法满足。

**Step 3: 同步文档和 schema 注释**

按设计文档更新启动、shutdown、compaction、Life Journal usage、测试环境与媒体后续债务；删除 `MemoryEntry` 过期 remember/recall 注释，是否删除 model 留给后续 schema 清理。

**Step 4: 扩展 repo-check**

让 checker 读取 `.env.example` 和引用模板路径，检查关键 env marker 与文件存在性。若选择删除模板引用，则断言文档不再引用不存在文件。

**Step 5: 验证并提交**

```bash
pnpm test -- src/ops/repo-check.test.ts
pnpm repo-check
git add README.md docs .env.example prisma/schema.prisma src/ops/repo-check.ts src/ops/repo-check.test.ts scripts/repo-check.ts
git commit -m "docs: 同步运行时可靠性契约"
```

### Task 8: 全量验证

**Files:**
- No production changes expected

**Step 1: 检查工作区和格式**

Run: `git status --short && git diff --check`

**Step 2: 运行静态检查**

Run: `pnpm typecheck && pnpm repo-check`

Expected: PASS。

**Step 3: 运行完整测试**

Run: `pnpm test`

Expected: 全部测试通过，且不需要本地 `.env`、数据库、NapCat 或真实 LLM。

**Step 4: 审查提交范围**

Run: `git log --oneline --decorate -10 && git status --short --branch`

Expected: 只有本计划相关提交，工作区干净。
