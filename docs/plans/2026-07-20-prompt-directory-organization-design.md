# Prompt 目录化组织设计

## 目标

把提示词的物理文件边界与实际加载单元对齐，优先改善人类维护体验。每个文件只承载一个明确主题，文件名直接表达职责，不再依靠一个 Markdown 内的 `<!-- section:... -->` 标记区分多份独立文档。

本次只重组静态提示词及其读取入口，不改变 Luna 的人格方向、行动模型、聊天硬边界、ledger、replay、compaction 或外部副作用契约。

## 目标目录

```text
prompts/
├── system/
│   ├── system.md
│   ├── persona.md
│   └── owner.md
└── chat-style/
    ├── index.md
    ├── constraints.md
    ├── base.md
    ├── anti-patterns.md
    ├── roleplay.md
    └── nsfw.md
```

原则是“一个物理文件对应一个实际加载单元”。文件内容直接作为 prompt 正文，不再使用 section marker 包裹。

## System 组织

- `system/system.md` 保存常驻模板，包括身份占位、运行环境、输入与外发、行动基线和按需披露。这些内容共同组成一份有顺序要求的常驻 system prompt，不继续按内部标题拆碎。
- `system/persona.md` 保存当前 `core` 人格底色。
- `system/owner.md` 保存可选的创作者关系基线。
- `bot-system-prompt.ts` 分别通过 `loadPrompt()` 读取三个文件，再沿用现有模板渲染顺序。

拆分时保持身份、owner 注入、来源列表和行动基线的最终拼装顺序。system 中不再硬编码全部风格主题名称，只保留按需读取风格索引的入口，避免工具 schema、帮助文本与 system prompt 三处同步维护。

## Chat style 组织

- `chat-style/index.md` 只负责主题路由和读取时机。
- `chat-style/constraints.md` 保存现有源隔离、消息长度和身份锚点。它本身只有一个职责，不继续细拆。
- `chat-style/base.md` 保存默认说话风格、自然接话、真实性与在场感。
- `chat-style/anti-patterns.md` 保存 AI 腔、客服腔、运维术语和结构化过度的反例。
- `chat-style/roleplay.md` 独立保存角色扮演和群聊玩法。
- `chat-style/nsfw.md` 独立保存 NSFW 场景口味。

删除含糊的 `special_cases` 聚合入口，未来调用直接选择 `roleplay` 或 `nsfw`。不保留兼容别名，也不保留旧文件转发壳。

## 加载与工具入口

`chat-style.ts` 直接把公开主题映射到独立文件，并使用 `loadPrompt()` 读取全文：

```text
constraints   → chat-style/constraints.md
base          → chat-style/base.md
anti_patterns → chat-style/anti-patterns.md
roleplay      → chat-style/roleplay.md
nsfw          → chat-style/nsfw.md
```

同步更新 `chat_style` schema、`workspace_bash style global` 解析、帮助文本、工具说明和文档。具体主题清单以工具 schema 和 `index.md` 为维护入口；system prompt 只指向索引，不复制完整列表。

`prompt-loader` 的进程内缓存机制保持不变，缓存单位自然变成单个文件。缺少任何目标文件时继续明确失败，不提供旧路径 fallback，避免静默加载不完整提示词。

迁移完成后删除：

- `prompts/bot-system.md`
- `prompts/bot-style.md`
- `prompts/bot-chat-constraints.md`

## 兼容性与 replay

项目采用干净目标模型，不为 `special_cases` 或旧文件路径增加 bridge。历史 ledger 中已有的 tool call/result 是持久事实，replay 时原样使用，不会重新执行旧调用或重新读取提示词文件；新 schema 只约束未来调用。

本次不改 ledger entry、projection、compaction、runtime state 或工具结果格式。部署重启后 system prompt 和工具声明会发生一次预期更新，因此 prompt cache 会失效一次；进程启动后仍保持字节稳定。无需数据迁移。

## 验证

采用 TDD 完成迁移：

1. 先增加新路径和新主题的失败测试。
2. 验证 system prompt 的身份、owner 注入、来源列表、行动基线及拼装顺序没有意外变化。
3. 验证 `chat_style` 每个主题只读取对应文件，`roleplay` 与 `nsfw` 不串位，`special_cases` 不再是合法参数。
4. 验证 `workspace_bash` 接受新主题并明确拒绝旧 `special_cases`。
5. 更新 `repo-check`：要求新文件完整存在、旧文件不存在，并禁止重新引入多 section 拼接模式。
6. 更新仍引用旧路径或旧主题的仓库文档。
7. 运行 focused tests、`pnpm repo-check`、`git diff --check`，并复核没有 ledger、runtime、schema 或外部副作用变更。
