# qq-bot-v2 多 scene 统一 runtime：Phase 0 / 1 落地状态

更新时间：2026-04-24

## 这份状态文档覆盖什么

这份文档只覆盖首轮 team-exec 已经落地的 **Phase 0 + Phase 1**：

- runtime contract freeze
- scene ingress
- focused target skeleton
- exact cue model

**不覆盖 Phase 2+**：

- focused-scene read-path cutover
- unified decision / send barrier 全量切换
- compaction / recovery 全量硬化

---

## 已落地的核心变化

### 1. root runtime snapshot 现在显式携带 scene / cue 元数据

当前 `RootRuntimeSessionSnapshot` 已经增加：

- `focusedTargetId`
- `sceneRecords`
- `outstandingCues`

对应类型：

- `SceneId`
- `FocusTargetId`
- `RuntimeSceneRecord`
- `RuntimeCue`

这意味着首轮实现已经把“多 scene / cue 生命周期”从隐含字段提升成了显式 contract。

### 2. `@self` 不再通过 pre-ingest mention-special path 决定执行

已完成的收口：

- `bot/core.ts` 不再先 dispatch 再 ingest
- `index.ts` 的 startup replay 也不再先 dispatch mention-special path
- cue 创建统一收口到 `rootRuntime.ingestGroupMessage(...)`

当前语义是：

1. 识别到 `@self`
2. 在 ingress 阶段形成 stable cue metadata
3. cue 被写入 runtime snapshot
4. live / recovery 再复用同一套 cue + unread 语义进入 passive execution

### 3. mention cue 已经有稳定 ID

当前 anchored mention 统一使用稳定 ID：

```txt
qq_group:<groupId>:message:<triggerMessageRowId>:reply_to_message
```

这套 ID 同时用于：

- `RuntimeCue.cueId`
- mention `replyIntentId`

它解决了之前 reply intent 依赖：

- `scopeKey`
- latest incorporated message

而导致的“同一个 anchored cue 语义不稳定”问题。

### 4. legacy mention replyIntentId 做了兼容回退

为了避免切换到 cue-based replyIntentId 之后：

- 启动恢复
- 历史 reply record 查重
- passive mention processor

出现重复发送，当前实现保留了 compatibility fallback：

1. 先查新的 cue-based `replyIntentId`
2. 查不到再查旧格式 `runtimeKey:scopeKey:trigger:incorporated`

这样 Phase 0 / 1 可以安全过渡，不会因为 ID 归一化直接破坏历史行为。

### 5. legacy assistant turns 迁移已对齐新的 stable intent id

`reply-record-migration` 已做两层处理：

1. legacy assistant turn upsert 到 `reply_records` 时优先归一化成新的 cue-based id
2. 迁移前先查 normalized id，再查 legacy id，避免重复迁移

---

## 当前仍然刻意保留的旧结构

首轮实现**没有**删除下面这些旧结构，因为它们仍然属于 Phase 2 之后的问题：

- sender-thread scoped context build
- passive mention processor 作为当前 generation owner
- `conversation_state.compactedBase` 的兼容读取面

这并不表示终局方案回退，而是因为本轮 scope 明确只到 Phase 1。

---

## 当前不变量

本轮完成后，可以认为以下不变量已经成立：

1. `messages` 仍然是唯一 inbound fact ledger
2. `reply_records` 已经成为新的 outbound interaction ledger 主体
3. `@self` cue 已经具备：
   - stable cue id
   - stable mention reply intent id
   - pending -> replied 生命周期
4. startup replay 不再通过 mention-special pre-dispatch 旁路推进
5. root runtime snapshot 已经具备 scene / cue / focused target 的显式数据面

---

## Review 结论

本轮 review 重点检查了三件事：

### A. 是否还存在 “先 dispatch，再决定是否 ingress” 的旁路

结论：**已去除**

- 在线消息入口已收口到 ingest
- startup replay 已收口到 ingest

### B. mention cue 与 reply record 的标识是否稳定

结论：**已稳定化**

- 新 cue / reply intent 已统一到 anchored cue id
- legacy 形态有 fallback

### C. 是否已经误入 Phase 2+

结论：**没有**

当前实现没有做：

- focused-scene prompt truth cutover
- sender-thread 主读取面删除
- unified decision engine 替换 passive mention processor

所以仍然符合首轮 team run 的 Phase 0 / 1 边界。

---

## 已验证证据

### Diagnostics

```bash
npx tsc --noEmit --pretty false --project /Users/zzz/WebstormProjects/qq-bot-v2/tsconfig.json
```

结果：

- 0 errors
- 0 warnings

### Typecheck

```bash
cd qq-bot-v2 && pnpm exec tsc --noEmit
```

结果：

- exit 0

### Build

```bash
cd qq-bot-v2 && pnpm build
```

结果：

- exit 0

### Full tests

```bash
cd qq-bot-v2 && pnpm test
```

结果：

- 204 pass
- 0 fail
- 2 skip

### Focused runtime tests

```bash
cd qq-bot-v2 && pnpm exec tsx --test \
  src/conversation/reply-record-migration.test.ts \
  src/runtime/passive-mention-processor.test.ts \
  src/runtime/root-runtime.test.ts \
  src/index.test.ts
```

结果：

- 27 pass
- 0 fail

---

## 下一阶段建议

如果继续往下推进，下一批应该进入：

### Phase 2

- 把 `buildContext()` 的主键切到 `focusedSceneId / causeCueId`
- sender-thread 不再作为根 runtime 主读取键
- 让 focused scene 成为唯一 prompt 原文真相

### Phase 3

- 用 unified decision engine 替换 mention-special generation owner
- 让 anchored / unanchored reply 共享同一 decision + send barrier

在进入 Phase 2 之前，不建议再新增任何 mention-special owner 或 sender-thread 主读取面的临时补丁。
