# 聊天风格 Prompt 去重设计

## 目标

保持 `bot-system.md` 的常驻人格与行动内核、`bot-chat-constraints.md` 的聊天硬边界不变，只清理 `bot-style.md` 内部重复，让每个按需 section 有单一职责，减少后续文案漂移和互相覆盖。

## Section 所有权

- `style_index`：只解释何时读取 `constraints`、`base`、`anti_patterns`、`special_cases`；文案明确“本 section 是索引”，不再误称整份文件不含细则。
- `style_base`：只保留正向默认语气、自然接话、真实性与在场感。可以说明主动聊天的口味，但不重复 system 的自主调度循环，也不声明全局固定“半参与”档位。
- `style_anti_patterns`：集中保存 AI 腔、客服腔、运维术语等反例；反例可以重复 base 的原则，但不新增行为政策。
- `style_special_cases`：只保存角色扮演和 NSFW 等真正特殊场景；删除通用的运维术语规则。
- `chat_constraints`：继续独立保存源隔离、身份锚点和消息长度规则，不在本次修改中重写。

## 具体清理

1. 把 index 的“这份文件只作为索引”改成“这个 `style_index` section 只作为索引”。
2. 从 `style_base` 删除完整的角色扮演流程，唯一详细版本保留在 `style_special_cases`。
3. 删除 `style_special_cases` 中通用的“不要说后台白名单/配置文件”等段落；正向规则留在 base，详细正反例留在 anti-patterns。
4. 删除 base 中与 system 自主行动重复的“不是等指令的监听器”“固定半参与”“空闲时翻外界/写日记”等调度文案。
5. 保留群聊自然参与的风格说明，但明确只适用于 participation 允许 ambient 的群，避免覆盖 `mentions` 群策略。

## Replay 与运行边界

修改不会改变 system prompt、工具 schema、ledger projection 或 runtime state。已经写入 ledger 的旧 `chat_style` tool result 保持原样；新调用读取启动后缓存的新版 section，并作为普通 tool result 追加，因此 replay 仍只依赖 canonical ledger。Bot 需要重启后才能清空 `prompt-loader` 的进程内文件缓存并使用新文本。

## 验证

- `chat_style` focused test 锁定 index 措辞和 section 所有权。
- `workspace_bash` focused test确认同一 section 路由仍正常。
- `pnpm repo-check` 检查 section marker 和 system 中的渐进披露入口。
- diff 必须只包含 `bot-style.md`、对应测试和本次设计/计划文档，不修改 system、constraints 或 runtime。
