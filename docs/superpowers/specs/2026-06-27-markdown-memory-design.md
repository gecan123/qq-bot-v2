# Markdown Memory 设计

## 背景

当前 `memory` 工具是 `action=write/search` 的统一入口，底层转发到 `remember` / `recall`，并通过 Prisma `memory_entries` 表保存 `{targetKind, targetId, content, sourceMessageIds, createdAt}`。这个模型适合“关于某个人/某个群的私人笔记”，但不适合 Luna 自己做事时形成的长期记忆，例如工作偏好、项目线索、踩坑记录、阶段性经验和主题资料。

本设计把 `memory` 从联系人/群聊备忘录升级为本地 Markdown 记忆库。第一步只替换存储和工具语义，不实现自动记忆提取、预取、Dream 反思或自动合并去重。

## 目标

- 保留 `memory` 作为 LLM 的高层入口，不要求 Luna 通过裸 `workspace_bash` 拼命令维护长期记忆。
- 底层不再依赖 DB，改用 `data/agent-workspace/memory/` 下的本地 Markdown 文件。
- 支持多类记忆：Luna 自己、人物、群、主题。
- 记忆文件可人工阅读和整理，但运行时仍通过受控工具结果进入 `AgentContext`。
- 给后续 s09 能力预留空间：自动提取、相关记忆预取、Dream/反思、合并去重。

## 非目标

- 不从 Markdown 文件重建 prompt history。
- 不把整份记忆库自动塞进 system prompt 或 prefix history。
- 不在第一步实现 embedding、向量检索、全库 LLM 去重或自动改写所有文件。
- 不把 `memory` 完全并入 `workspace_bash`。`workspace_bash` 可以保留为调试和文件整理能力，但不是长期记忆的主入口。

## 架构

新增一个小的 file-backed store，例如 `src/agent/memory-store.ts`。它只负责文件路径选择、Markdown frontmatter 读写、搜索、读取、输出裁剪和坏文件容错。`src/agent/tools/memory.ts` 调用这个 store，继续作为注册给 LLM 的工具。

存储根目录：

```text
data/agent-workspace/memory/
  self/
  people/
  groups/
  topics/
  inbox/
```

推荐文件布局：

```text
data/agent-workspace/memory/
  self/
    working-notes.md
    preferences.md
    reflections.md
  people/
    123456.md
  groups/
    987654.md
  topics/
    qq-bot-v2.md
    browser-sidecar.md
  inbox/
    proposals.jsonl
```

`inbox/` 只预留给后续自动提取候选。第一步可以不启用。

## Markdown 格式

每个文件使用极简 frontmatter 加自由 Markdown 正文。frontmatter 用来稳定定位和排序，正文允许 Luna 自然整理。

```md
---
scope: self
title: working-notes
updatedAt: 2026-06-27T00:00:00.000Z
aliases: []
---

## 稳定记忆

- ...

## 最近线索

- ...

## 已废弃或不确定

- ...
```

`scope` 可选值：

- `self`：Luna 自己做事、偏好、经验、长期线索。
- `person`：关于某个 QQ 用户。文件名使用 `<qq>.md`。
- `group`：关于某个群。文件名使用 `<groupId>.md`。
- `topic`：关于一个主题、项目或长期任务。文件名使用 slug。

正文不强制统一成表格。统一表格会方便解析，但会削弱“自己做事情的记忆”的表达能力，也不利于人工整理。

## 工具语义

`memory` 保留 action-driven 入口，建议演进为：

- `action=write`：写入一条长期有用的事实、经验或线索。参数包含 `scope`，其中 `person/group` 需要 `id`，`self/topic` 不需要 QQ/group id。
- `action=search`：跨 `self/people/groups/topics` 搜索，返回命中文件、短片段、scope、title、updatedAt，不返回整篇长文。
- `action=read`：读取一个明确的记忆文件，返回完整内容或上限内内容。
- `action=merge`：第一步不实现。后续可以作为受控整理动作，合并同一文件内重复或过时段落。

`write` 不应只是无限 append 到文件末尾。初版可以保守地追加到“最近线索”或文件末尾，并更新 frontmatter 的 `updatedAt`。后续合并去重再负责整理成“稳定记忆”。

## 数据流

写入：

1. LLM 调用 `memory action=write`。
2. 工具根据 `scope` 和可选 `id/title/topic` 找到或创建 Markdown 文件。
3. store 更新 frontmatter 的 `updatedAt`，并追加一条带时间的 Markdown bullet。
4. 工具返回 `{ok:true, path, scope, title}` 这类短结果。

搜索：

1. LLM 调用 `memory action=search`，可传关键词、scope、limit。
2. store 遍历记忆目录，跳过坏 frontmatter 文件并计数。
3. 对文件名、frontmatter、正文做大小写不敏感的子串匹配。
4. 返回最多 `limit` 条短片段，按 `updatedAt` 和命中位置排序。

读取：

1. LLM 调用 `memory action=read`，传工具返回的 file id/path。
2. store 校验路径不能逃出 memory root。
3. 返回有长度上限的 Markdown 内容；超长时截断并提示。

## 错误处理

- frontmatter 坏了：`search` 跳过并返回 `skippedCorrupt`，日志记录相对路径。
- 文件不存在：`read` 返回结构化 not found，不让 agent loop 抛异常。
- 路径非法：返回结构化错误，不能读取 memory root 外的文件。
- 单文件过大：`read` 截断，`search` 只返回短片段。
- 写入内容过长：沿用当前工具的短内容约束，避免把长聊天原文写进长期记忆。

## AgentContext 边界

Markdown 记忆库是 side data，不是 LLM ledger。它不能用于 replay，也不能在启动时反向重建 prompt history。新的 LLM 可见事实只能通过 `memory search/read/write` 的 tool result、普通事件 append 或受控 compaction 进入 `AgentContext`。

## 后续 s09 扩展

自动提取：

- 后续可以在 round 后或 tool hook 后产生记忆候选。
- 候选先落到 `memory/inbox/`，不直接改写稳定记忆文件。
- Luna 或 owner 可以通过后续工具动作审核、写入或丢弃候选。

预取：

- 后续可以在 `runRound` 前基于当前事件提取 person/group/topic hint。
- 预取只注入极短摘要，不读取整篇 Markdown。
- 预取必须有 token 上限，并保持可关闭。

合并去重：

- 优先整理同一个 Markdown 文件，不做第一版全库智能重排。
- 先用路径、title、aliases、简单关键词做候选匹配。
- 需要 LLM 参与时，让 LLM 生成受控 patch 或新的文件内容，再由工具写入。

Dream/反思：

- journal 继续保存日记/梦境原始记录。
- memory 保存整理后的长期结论，例如 `self/reflections.md` 或 `topics/<slug>.md`。

## 文档和测试

需要更新：

- `docs/TOOLS.md`：说明 `memory` 是本地 Markdown 记忆库，不再是 DB 私人笔记。
- `prompts/bot-system.md`：progressive-disclosure 中的 `memory` 描述改为 `self/person/group/topic` 多范围记忆。
- `docs/agent-skills/memory_hygiene.md`：补充 Luna 自己做事的记忆边界。

建议测试：

- `src/agent/memory-store.test.ts`：创建、写入、读取、搜索、坏 frontmatter 容错、路径逃逸拒绝、输出裁剪。
- `src/agent/tools/memory.test.ts`：schema、`self/person/group/topic` scope、`write/search/read` 行为。
- `src/agent/tools/merged-tools.test.ts`：注册面仍只有 `memory`，不重新暴露 `remember/recall`。
- `pnpm repo-check`：验证工具注册和文档同步。

## 验收标准

- `memory` 可以写入和搜索 `self` 记忆，不需要 QQ 或群 id。
- `person/group` 记忆仍然可表达当前已有的私人笔记场景。
- 记忆文件落在 `data/agent-workspace/memory/`，默认不提交生成内容。
- 工具结果有上限，坏文件不会打断 agent loop。
- 不改变 replay 和 compaction 的核心不变量。
