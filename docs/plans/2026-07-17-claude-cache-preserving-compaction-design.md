# Claude 缓存复用 Compaction 设计

## 目标

让 Claude compaction 复用主 Agent 已建立的 prompt cache，避免用新的 system prompt 和重序列化 transcript 重新处理整段待压缩历史，同时保持现有 append-only ledger、确定性 replay、recent tail、tool 原子性和 CAS 提交契约不变。

本阶段只修改 `claude-code` provider。OpenAI 路径继续使用现有专用 summarizer 请求。

## 当前问题

主 Agent 的 Claude 请求会缓存稳定 system prefix 和当前 messages prefix。现有 compaction 则构造另一份请求：

- 使用专用 compaction system prompt；
- 不发送主 Agent tools；
- 把历史重新序列化进 `[UNTRUSTED_DATA]` envelope；
- 再追加摘要触发指令。

这份请求与主 Agent 的 `tools -> system -> messages` prefix 不同，因此无法复用主对话的大段 cache。相同 TTL 或 cache key 不能弥补 prefix 字节变化。

## 方案

保留 compaction preparation、candidate validation 和 commit 流程，只为 Claude 增加 cache-preserving summarizer path。

### 请求形态

Claude compaction 请求使用与主 Agent 相同的：

- model；
- system prompt 字节；
- tool declarations 及顺序；
- thinking 配置；
- provider message serialization。

待压缩的 canonical message prefix 保持原始 role、tool call 和 tool result 结构。请求末尾追加一条固定、可信的 compaction control message，要求模型只输出摘要、不得调用工具、不得继续对话，并说明旧 prefix 将由该摘要替代。

OpenAI 继续走现有 `buildCompactionSummarizerRequest()` 路径。

### Cache boundary

主 Agent 的 Claude working request 除现有 system 和 latest-message breakpoint 外，还在当前确定性 future compaction cut 上放置一个 provider-only cache breakpoint。该标记只属于单次 wire projection，不写入 ledger，也不改变 replay 字节。

真正 compact 时，Claude summarizer 使用同一 system、tools 和截至该 cut 的原始 message prefix，再追加 control message。这样 breakpoint 之前的 prefix 可以命中主请求已经写入的 cache。

future cut 必须复用现有 compaction atomic-unit 和 token-cut 规则，不能另建一套会切开 assistant tool call/result 的边界算法。若当前没有合法 cut，则只保留现有 latest-message breakpoint。

### 输出与安全

Claude compaction 调用可以看见 tool declarations，但 Runtime Host 不执行该调用返回的任何 tool call。只接受无 tool call 的普通文本摘要；出现 tool call、空文本、截断或 provider 错误都按 summarizer failure 处理，canonical ledger 不变。

摘要继续通过现有固定标题、token 上限、split-turn 和完整 candidate projection 校验。mailbox attention、rest resume 等受控机器状态继续从 canonical prefix 确定性捕获，不交给模型生成。

### 持久化与竞态

成功摘要仍生成现有 `CompactionLedgerPayload`，通过 `appendCompaction(expectedHeadEntryId)` CAS 提交。head race、失败退避、manual/overflow 语义、checkpoint 刷新和 `afterCompact` 行为不变。

缓存只是性能优化，不成为事实来源。cache miss、过期或 provider 不支持额外 breakpoint 时，压缩仍应得到相同合法摘要请求语义，只是成本和延迟更高。

## 组件变化

- `compaction.ts` / `bot-loop-agent.ts`：向 summarizer 提供主 Agent system、tools、thinking 和确定性 prefix 输入，并按 provider 选择 Claude cache-preserving path 或现有 path。
- `claude-code/request.ts`：支持在指定合法 message block 上附加额外 1h cache breakpoint，同时保留 system 和 latest-message breakpoint。
- `llm-client.ts`：为 compaction 暴露 provider-aware、不可执行工具调用的生成入口，或提供足够元数据让 Runtime Host 选择对应请求形态。
- 现有 ledger schema、projection、Prisma schema 和 OpenAI adapter不变。

## 验证

测试先行覆盖：

1. Claude 主请求在合法 future cut 和最后一条 message 上同时放置 breakpoint。
2. breakpoint 不切开 assistant tool call/result 原子组。
3. Claude compaction 请求与主 Agent共享 system、tools、thinking 和原始 prefix，只在末尾新增 control message。
4. Claude compaction 返回 tool call、空文本或截断时失败且不提交 ledger。
5. OpenAI compaction 请求保持现有专用 summarizer形态。
6. 现有 projection、split-turn、CAS race、overflow/manual 和 replay 测试继续通过。

运行 focused tests、typecheck、`pnpm repo-check`，再根据影响面运行完整测试。

## 非目标

- 不迁移 OpenAI 到 Responses API。
- 不采用 provider 原生 compaction block 作为 canonical history。
- 不修改 compaction summary schema 或七标题契约。
- 不改变默认 reserve、keepRecentTokens 或 failure backoff。
- 不从 cache、日志或 provider state 重建 ledger。
