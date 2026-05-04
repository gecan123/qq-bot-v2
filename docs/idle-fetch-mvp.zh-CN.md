# Idle-Fetch MVP — 让 bot 自己刷 Reddit

Status: DRAFT
Date: 2026-05-04
Branch: single-context-mvp
Mode: Builder
Scope: **Reddit only**. v2ex / HN / 其他源都不做, 等 reddit 跑两周看到价值再说.
Supersedes: 无 (本分支首个 idle-fetch 设计)

## 目标 (一句话)

让 bot 在长时间没人说话时自己起意刷一下 reddit, 挑有意思的东西主动分享到群里 / 私聊里. 不引入新调度循环, 不破任何 perpetual-context 红线.

## 现状 (作为参照)

刚 ship 完 MVP-2 多源 single-context. bot 当前只能 reactive: NapCat 来消息 → drainEvents → runRound → send_message / wait. 主 loop 在 `bot-loop-agent.ts:149-158`, 闲下来就 park 在 `waitForEvent()` 上, 完全被动.

CLAUDE.md「子 TaskAgent 模式」段落提到过未来要让 bot 啃外部数据但不污染主 context. 这个 MVP 是该方向的最小落地版本 — 但故意避开真子 agent 的复杂度, 第一版用直接 fetch + 默认 LLM 单步摘要顶上.

## Premises (设计的前提, 不能动摇这几条)

1. **不加新 loop**. 主循环原样不动. idle 触发靠 wait 工具自己挂的 setTimeout, 不引入 setInterval / 后台守护循环.
2. **不破红线 5 (确定性回放)**. idle 不写进 messages 表. 它一旦作为工具结果 append 进 AgentContext 就冻结, 重启时 snapshot 自带, replay-missed 不重生 idle 事件.
3. **不破红线 4 (compaction 是唯一前缀写口)**. idle 走正常 `appendToolResult` 路径.
4. **不破红线 3 (发声靠 send_message + 白名单)**. bot 找到东西后还是用现有 send_message 发到监听中的源, 不开新广播通道. fetch 工具自己不发声.
5. **抓回的原始内容不进主 context 数组**. 工具返回的是已截断 / 已摘要的短文本. 不让长 HTML / 长 RSS feed 进 messages.
6. **工具实现层硬截断 (隐性强约束)**. fetch_reddit 一次 RSS 几十条, 原文塞回 context 一次就 3-5k token, 2-3 次就快 compact. 必须在 tool 实现里硬截:
   - `fetch_reddit`: 最多回前 N 条 (默认 N=10), 每条 ≤ 200 字 (title + 短 summary).
   - `fetch_url`: 单页正文截到 ≤ 8KB 再送默认 LLM 摘要; 摘要输出 ≤ 1500 字符 (~500 中文字).
   - 工具描述里必须对 LLM 写明"此工具只返回简要, 需要深读再调一次", 否则 LLM 会以为自己看全了.
7. **加 NDJSON 旁路日志, 不加表**. 在 fetch tool 里 appendFile 一行 `{ts, url, status, bytes, toolCallId}` 到 `logs/fetch.ndjson`. 这是**运维信息**, 不是数据持久化, 不进 Prisma, 不进任何 schema. 跟"bot 自己 send_message 不进 messages 表"的对称约束不冲突 — 那条说的是不污染消息账本, 不是禁止运维日志.
8. **replay 不重跑 fetch (红线 5 的子约束)**. 启动恢复 snapshot 时, 历史 tool result 是字节快照, 直接当 message 还原. **绝对不允许** replay 阶段重新发 HTTP 求"新值" — 那样 prefix 不字节稳定. 现有 BotLoopAgent.start 是对的 (它只 `restorePersistedSnapshot`, 不重跑 tool), 但 fetch 是新工具种类, 在 PR 里得显式复述这条不变量.
9. **MVP 不引入 OAuth, 不持久化 token, 不做评论/全文提取**. 只读公开 RSS / JSON feeds.
10. **网络可达性默认 OK**. 部署机本身有 TUN-mode VPN, reddit 能直连. 工具不用写代理逻辑, fetch 走 Node 默认 agent. (如果哪天换部署环境再说.)

## 关键架构: idle 触发模型

唯一改动是 wait 工具加 timeout. 流程:

```
runOnce (现有 loop, 一行不改):
  drainEvents
  runRound:
    LLM 决定调 wait
      wait.execute (新):
        Promise.race([
          eventQueue.waitForEvent(),    ← 真消息到 → return 'ok'
          sleep(IDLE_THRESHOLD_MS),     ← 静默到点 → return idle hint
        ])
        if idle:
          eventQueue.enqueue({type:'wake'})  ← 戳一下 Guard 2 不阻塞
          return { content: '[空闲提示]...' }
  persist + maybeCompact
  Guard 2: queue 有 wake → 不 block → 下一轮立即跑
  drainEvents 看到 wake 跳过 (现有逻辑)
  ranRound: context 非空 → runRound
    LLM 看到 history 末尾的 idle 提示 → 决定 fetch_reddit / fetch_url / 还是 wait
```

具体场景时间线:

```
14:00  群消息 → enqueue → drainEvents → append → runRound
       LLM 回复 + 调 wait   wait 阻塞计时 30min

14:30  没人说话, sleep 赢 race
       wait return idle hint, append 为 tool result
       wait 顺手 enqueue {type:'wake'}
       round 结束, persist
       下一轮: drain wake 跳过, ranRound=true, 跑 round
       LLM 看到 idle 提示, 决定:
         a) fetch_reddit subreddit=programming
         b) fetch_reddit          (无 subreddit, 拉首页)
         c) 没兴趣继续 wait
       假设它选 a, 拿到 10 条 title+link+短摘要
       继续: 选最有意思那条调 fetch_url 单独抓全文摘要
       调 send_message target={type:'group', groupId:111} text='看到这个挺有意思: ...'
       再调 wait → 又阻塞 30min, 引信重新计时

14:10 (vs 14:00 还没 30min 时来了消息):
       eventQueue.waitForEvent 这条赢 → wait return 'ok'
       round 结束, drain 处理新消息, idle 没发生
```

## 工具改动清单

### 1. `tools/wait.ts` 改 (~15 行)

加 `IDLE_HINT_MS` 常量 (默认 30min, env 可覆盖 `BOT_IDLE_HINT_MS`). Promise.race 实现. 文档行加一句"长时间没事件你会拿到空闲提示, 收到时可选择刷东西 / 主动找谁聊 / 继续 wait".

### 2. `tools/fetch_reddit.ts` 新 (~70 行)

工具名直接叫 `fetch_reddit`, 不做"通用 feed 工具". 以后真要加 v2ex / HN 时**新加 fetch_v2ex / fetch_hn 工具**, 互不耦合, 工具描述各自精确, 不靠 source 字面量分发.

```ts
fetch_reddit({
  subreddit?: string,        // 默认 undefined = 首页 /.rss; 'programming' 之类指定 sub
  sort?: 'hot' | 'top' | 'new',  // 默认 'hot'
  limit?: number,            // 默认 10, 硬上限 10
})
  → { content: 多行 markdown列表 (title | link | 短 summary) }
```

实现:
- URL 拼装:
  - `subreddit` 缺省: `https://www.reddit.com/.rss` (首页) 或 `.../{sort}.rss`
  - `subreddit='programming', sort='hot'`: `https://www.reddit.com/r/programming/hot.rss`
  - 多 sub 合一: 不在 MVP 里做, 想要就让 LLM 调多次.
- 用 `fast-xml-parser` 解析, 提取 `<entry>` 的 title / link / summary / author / published.
- summary 字段 reddit RSS 给的是 HTML, 用简单 regex 去 tag 拿纯文本 (不引入 cheerio 仅为这个).
- User-Agent 显式设 `qq-bot-v2/0.x by /u/<your_username_or_anything>` — reddit 对默认 UA 越来越严, 自定义 UA 通过率高很多.
- timeout 走 `AbortController` + `BOT_FETCH_REDDIT_TIMEOUT_MS`.

**硬截断 (premise 6)**:
- `limit` zod schema `.max(10)` 卡死, LLM 传 100 也只回 10.
- 每条: title 截 80 字, summary 截 120 字 (字符级 slice).
- 整体输出 ~2KB 上限, 不会某 sub 突然 50 条爆量.

输出形态:
```
- {title (≤80字)} | {url} | {short summary (≤120字)}
- ...
```

**工具描述里 (给 LLM 看的) 必须包含**:
> 拉 reddit RSS, 仅返回前 10 条简要 (标题 + 短摘要). 想深读某一条 → 拿那条 url 调 fetch_url. 不要因为没给详情就反复调它换 limit, 最多 10 就是 10. 暂时只支持 reddit, 别问其他站.

每次调用末尾在 `logs/fetch.ndjson` appendFile 一行, `source: 'reddit'` (见第 7 项).

### 3. `tools/fetch_url.ts` 新 (~50 行)

```ts
fetch_url({ url: string, hint?: string })
  → { content: ≤ 1500 字符 markdown 摘要 }
```

实现:
1. fetch HTML / 文本, response body 流式读取, 超过 256KB 提前断流 (避免拉巨型页面).
2. 如果 HTML, 用 `cheerio` 抽 `<title>` + `<meta description>` + `<article>` / `<main>` 文本.
3. **硬截断**: 抽出来的正文先 slice 到 8KB (~2-3k token), 才送默认 LLM 摘要. 不让 30KB 文章把摘要 prompt 撑爆.
4. 调默认 LLM 摘成 ≤ 500 字中文摘要. hint 可影响摘要侧重.
5. **输出再截一次**: 摘要 + 元信息 (原 URL, 站点 title) 总长度 ≤ 1500 字符. 即使 LLM 没听话给了长摘要, 输出层也卡死.
6. 摘要 LLM 失败 → fallback 直接返回原文截断到 1KB + 错误标记.

**工具描述里必须包含**:
> 返回的是 ≤ 500 字中文摘要, 不是原文. 如果摘要不够你判断, 没办法让这个工具给你更长 — 要么换工具 (search) 要么放弃这条.

每次调用末尾在 `logs/fetch.ndjson` appendFile 一行 (见第 7 项).

### 4. `tools/index.ts` 注册新工具

`buildBotTools` 里加 `fetch_reddit`, `fetch_url`. 给它们写好工具描述 (system prompt 启动时拼一次, 运行时不变, 红线 5 满足).

### 5. `bot-system-prompt.ts` 加一段

在 `[行动方式]` 段落里追加:
- `fetch_reddit`: 拉 reddit RSS 看最近热的. 收到空闲提示时主要靠它.
- `fetch_url`: 想抓某个具体页面时调 (典型: fetch_reddit 给了 10 条, 挑一条想深读).
- 强调"刷出来的东西要值得分享才用 send_message 发, 不值得就咽下去 / 继续 wait".

新增 `[空闲行为]` 段:
> 当你看到 `[空闲提示] 已闲置 X 分钟` 这条工具结果时, 你处于自由时段. 可以:
>   - fetch_reddit 看看有啥, 挑有意思的发到合适的群 / 私聊
>   - 主动找某个最近没说话的人 / 群随意起个话题 (谨慎, 别频繁打扰)
>   - 直接再 wait, 没什么想看的就别硬刷
> 不要每次空闲都 fetch — 你的判断比频率重要.

### 6. 配置加 env (config/index.ts)

```
BOT_IDLE_HINT_MS              默认 1800000 (30min)
BOT_FETCH_REDDIT_TIMEOUT_MS     默认 8000
BOT_FETCH_URL_TIMEOUT_MS      默认 12000
BOT_FETCH_LOG_PATH            默认 logs/fetch.ndjson (旁路日志, 见第 7 项)
COMPACTION_TRIGGER_TOKENS     已存在, 默认 16000; MVP 调试期可临时上调到 24-32k 看 idle 频率影响
```

### 7. `ops/fetch-log.ts` 新 (~30 行) — 旁路 NDJSON 日志

不算"加表" — 是运维信息, 不进 Prisma.

```ts
import { appendFile } from 'node:fs/promises'
import { config } from '../config/index.js'

export async function logFetch(entry: {
  ts: string         // ISO8601
  source: string     // 'reddit' | 'url'  (MVP 只这俩 — fetch_reddit 写 'reddit', fetch_url 写 'url')
  url: string
  status: number     // HTTP status, -1 表示网络层失败
  bytes: number      // 拿到的 raw bytes
  toolCallId: string
  durationMs: number
  errorKind?: string // timeout | parse_error | etc
}): Promise<void> {
  try {
    await appendFile(config.fetchLogPath, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // 日志写失败不影响 tool 主流程, 静默 swallow
  }
}
```

`logs/` 加进 `.gitignore` (检查一下是不是已经在了). 部署时运维自己 logrotate 就行, MVP 不内置切片.

两周后 grep + jq 想看的几个数 (具体在 `docs/reddit-mvp-review.md`):
- 一天 fetch 几次: `cat logs/fetch.ndjson | wc -l`
- 重复 URL 比例: `jq -r .url logs/fetch.ndjson | sort | uniq -c | sort -rn | head`
- 命中失败的源: `jq -c 'select(.status<200 or .status>=300)' logs/fetch.ndjson`
- 平均 fetch 大小: `jq -s 'map(.bytes) | add/length' logs/fetch.ndjson`

## 红线影响检查

| 红线 | 影响 | 论证 |
|---|---|---|
| 1. AgentContext 唯一源 | 无 | idle 走 appendToolResult, 跟其他工具一样 |
| 2. messages 表只读 | 无 | idle 不进 messages 表 |
| 3. send_message + 白名单 | 无 | bot 找到东西后还是用 send_message, target 必填, 白名单不变 |
| 4. compaction 唯一前缀写口 | 无 | replaceMessages 没人新调 |
| 5. 确定性回放 + 字节稳定 | 需要论证 ↓ | |

红线 5 详细论证:
- system prompt 增加新工具描述 = 启动时拼一次, 整段会因新工具一次性失效, 这是预期 (跟 MVP-2 改 prompt 一样).
- idle 提示文本是常量, 同一时间触发输出同样字节. 但触发时机依赖 wall-clock, 跨重启不可重放. 这没问题: 一旦 append 进 messages 数组就冻结, snapshot 持久化里就有, 重启后 LLM 看到的 prefix 完全一致.
- replay-missed 只重放 messages 表内容. idle 不在表里, 所以重启不会"重放"已发生的 idle. 新的 idle 引信在 wait 工具里, 重启后第一次 wait 才装上 — 中间空 30min 才 fire 一次. 跟"重启后 cache 失效"语义对齐, 可接受.
- fetch_reddit / fetch_url 的输出有 LLM 摘要参与. 摘要文本不是字节稳定 (LLM 抽样有随机性). 但摘要作为 tool result append 一次后冻结, 不重渲染, 不重摘要. 跟 MVP-2 媒体描述 `resolved_text` 一次冻结的处理同源.

结论: 红线 5 满足.

## 持久化语义 (新加, 之前文档盲点)

### tool 结果走 snapshot, 不进 messages 表

```
fetch_reddit / fetch_url 返回 content
  → context.appendToolResult({ toolCallId, content })
  → 进 AgentContext.messages[] 数组
  → persistSnapshot 写到 bot_agent_snapshot.context_snapshot (单行表)
  → 跨重启可恢复 (snapshot.restorePersistedSnapshot)
  → compaction 触发 (默认 16k token) 时进入摘要被压缩
```

它**确实持久化** — 在 snapshot 里, 跟其他工具结果同等地位, 重启不丢. 但**没有独立查询入口**: db_read 看不到 (messages 表只装 QQ 真消息), 没有"刷过的链接"独立表. 跟 bot 自己 send_message 不进 messages 表的策略对称.

| 场景 | 行为 |
|---|---|
| 重启后还记得早上刷过啥 | ✅ snapshot 恢复, 只要还没被 compaction 摘要 |
| 1 小时内不重复推同一篇 | ✅ LLM 看到刚刚 history, 自己避免 |
| 一周前推过的, 今天再推一次 | ❌ 大概率被 compaction 摘掉了, LLM 不知道具体推过哪条 |
| db_read "我最近从 reddit 看过哪些" | ❌ 查不到 (但 NDJSON 旁路日志里有, 见下) |
| 分析 "bot 一天 fetch 几次 / 命中率" | ❌ AgentContext 看不出, 但 NDJSON 能 |

### NDJSON 旁路日志 (运维信息, 非数据持久化)

`logs/fetch.ndjson` 每次 fetch 调用 appendFile 一行. **它和 AgentContext 独立**:
- AgentContext 是 LLM 的"记忆", 受 compaction 影响, 字节稳定.
- NDJSON 是运维的"账本", grep + jq 可分析, 不影响 prefix cache, 跟红线 5 完全无关.
- LLM 看不到这个文件 (没工具开放), 也不该看到 — 它该用自己的 history 判断, 不该依赖 grep 自家日志.

两周后凭 NDJSON 决定要不要升级到真的"加表"(`bot_shared_link` 之类), 见升级路径段.

### replay 路径: 不重跑 fetch (红线 5 子约束)

启动恢复流程 (`src/index.ts` 启动顺序):
```
snapshotRepo.load()
  → context.restorePersistedSnapshot(persisted.snapshot)
  → messages 数组字节级 clone 出来
  → BotLoopAgent.start() 进 while 循环
  → drainEvents (看 queue, 没事件就 park)
  → 不会触发已 append 的 tool 调用重新执行
```

历史 fetch 工具结果是**字节快照**, 不是"占位等重新求值". snapshot 里写着 `{role: 'tool', toolCallId: 'abc', content: '某 reddit 帖摘要 ...'}` 就是这个字符串本身, replay 时这个字符串原样还原, 不再发 HTTP. 这是红线 5 (字节稳定) 的必要条件.

PR 描述里得显式复述这条不变量 — 因为 fetch 是新工具种类, code reviewer 容易问"那重启后会不会重新刷一次". 不会. 任何"重启后试图调用 fetch 求新值"的实现都是错的.

### 短期记忆窗 (compaction 之前的"原始记忆"时长)

trigger 按默认 `COMPACTION_TRIGGER_TOKENS=16000` 估算:
- 中英混合 → 触发约 35-40k 字符
- bot 一轮典型 200-500 字 (user msg + assistant + tool result)
- → **80-200 轮才 compact 一次**
- idle 间隔 30min, 一次 idle ~3-4 轮 (idle hint + fetch_reddit + fetch_url + send), 加上 QQ 真消息流量
- → 实际跑下来大概 **半天到一天 compact 一次**

也就是说 **半天到一天内的 fetch 历史 LLM 能直接看到**, 之后被压缩成摘要. MVP 阶段这个窗口够用.

如果实际跑下来发现 fetch 频繁导致 compaction 提前, 可以把 `COMPACTION_TRIGGER_TOKENS` 临时调到 24-32k 做对比实验 (注意这个旋钮影响 cache 命中, 但调高只是延后第一次 compact, 之后 cache 行为不变). 这是调参不是架构决策, 留作 MVP 阶段可用旋钮.

## 测试计划

### `tools/wait.test.ts` 新

- 真事件先到 → return ok, 不触发 idle
- timeout 先到 → return idle hint, enqueue wake
- timer 在事件先到时被 clearTimeout 清掉 (无泄漏)
- 自定义短 timeout (注入而非真等 30min)

### `tools/fetch_reddit.test.ts` 新

- RSS parser: 给 fixture XML, 验证抽取 title / link / summary / author
- subreddit / sort 参数拼到正确 URL
- subreddit 缺省 → 命中 `/.rss` 首页
- HTTP 失败 (404 / 5xx / 网络层) → 返回 error content (不抛, 让 LLM 看到失败原因)
- timeout 触发 (AbortController 提前断流)
- **硬截断 (premise 6)**: limit 传 100 也只回 10 条
- **每条字符截断**: title 80 字 / summary 120 字 (含中文 / emoji 边界)
- summary 里的 HTML tag 被剥干净
- 调用后 NDJSON 写入了一行 (mock appendFile)

### `tools/fetch_url.test.ts` 新

- HTML → cheerio 抽文 → mock 摘要 LLM → 检查格式
- 非 HTML (纯文本) → 截断 → 摘要
- 摘要 LLM 失败 → fallback 截断 + 错误标记
- **输入硬截断**: 30KB 长文章送进去, 实际给 LLM 的 prompt ≤ 8KB
- **输出硬截断**: mock LLM 故意返回 3000 字, tool 输出 ≤ 1500 字符
- response body > 256KB 提前断流
- 调用后 NDJSON 写入了一行

### 集成 (可选, MVP 不强求)

- 注入 fake Time + fake EventQueue + fake LLM, 跑完整 wait → idle → fetch_reddit → send_message 链路, 验证 messages 数组形态.

## Out of Scope (这版不做)

- **Reddit 之外的所有源** (v2ex / HN / 微博 / 即刻 / RSS 通用聚合 / ... 全不做). MVP 唯一外部源是 reddit. 等跑两周确认 fetch + idle 这套链路有产出, 再考虑加. 加的方式是**新建 fetch_v2ex / fetch_hn 等独立工具**, 不做"通用工具靠 source 字段分发".
- 真子 TaskAgent (开独立 LLM 循环). 等 MVP 跑两周看 fetch_url 单步摘要够不够用.
- Reddit OAuth (评论 / 搜索 / 投票). 没需求.
- 持久化"已分享过的链接"去重表. MVP 靠 LLM 看 history + NDJSON 旁路日志 (运维分析用) 自己避免重复.
- 智能 idle 间隔 (根据时段调整, 比如夜里不打扰). 第一版固定阈值, 实际跑跑看再调.
- idle 反复触发的 throttle (bot 连续 wait → 连续 idle). 第一版相信 LLM 自己判断, 看真实表现再加机制.

## 已知 Trade-offs

1. **idle 计时器在 wait 工具内, 每次 wait 重置**. 跟 IdleScheduler "真事件 reset" 语义略不同 — 实际"没人说话"场景两者等价, 区别只在事件密集时. 简单优先.
2. **idle 触发后必跑一轮 LLM**, 即使 bot 决定继续 wait. 一天约 48 次 idle = 48 次额外 round = 不可忽略 token 成本. 真嫌贵把 `BOT_IDLE_HINT_MS` 调到 2-3 小时.
3. **fetch_url 摘要走默认 LLM**. 如果默认 model 是贵的, 长文摘要烧 token. 之后可以走 `LLM_SCENARIO_SUMMARIZE_*` 路由到便宜模型, 跟现有媒体描述路由同模式. 第一版不加.
4. **reddit RSS 不带 score**. bot 可能挑些低赞的怪东西分享. 风险可控 — bot 看 title 自己决定品味, 比按 score 排序更"它"一些.
5. **cheerio / fast-xml-parser 是新依赖**. 多 ~200KB 体积, 可接受.
6. **`COMPACTION_TRIGGER_TOKENS` 是 MVP 阶段可用旋钮**. 当前默认 16k. 如果实跑发现 fetch 让 compact 来得太频繁 (例如半天就触发, 把刚 fetch 完的东西马上压缩掉, LLM 失忆), 临时调到 24-32k 看效果. 调高只延迟首次 compact, 不破坏 cache 行为. 也可能反向: idle 频繁但实质内容少, compact 一直不触发, snapshot 越长 cache 全 hit 也没事. 这个数据靠 NDJSON 跑两周后看.

## 升级路径

跑两周后看实际数据决定下一步:

- **如果 fetch_url 摘要质量差 (经常错过重点 / 误读)** → 升级到真子 TaskAgent: 子 LLM 循环带 fetch + 自主多步导航.
- **如果 bot 频繁 idle 但分享质量低** → 加一个"分享前自评"步骤, 或者引入 IdleScheduler 真"事件驱动 reset"语义.
- **如果 reddit 用得多, 但缺 score / 评论数 / flair** → 升级 reddit 工具到 OAuth, 或加 `.json` endpoint (现已不稳定, 但有时能用) 拿结构化字段.
- **如果想接 reddit 评论树 / 搜索** → 这才是 OAuth 该上的时候.
- **如果 reddit 用得不多** → 不一定加更多源就有用. 看 NDJSON 数据决定: 如果 reddit 都没人用, v2ex/HN 加上也是浪费.
- **如果 reddit 有用, 想接更多源** → 按 Out of Scope 段说的, 一种源一个工具 (fetch_v2ex / fetch_hn), 不搞通用分发.

## 文件改动总览

```
新:
  src/agent/tools/fetch-reddit.ts          ~70 行
  src/agent/tools/fetch-reddit.test.ts     ~70 行
  src/agent/tools/fetch-url.ts             ~60 行
  src/agent/tools/fetch-url.test.ts        ~60 行
  src/agent/tools/wait.test.ts             ~40 行
  src/ops/fetch-log.ts                     ~30 行 (NDJSON appendFile, 容错)
  src/ops/fetch-log.test.ts                ~30 行
  docs/reddit-mvp-review.md                占位文档 (已建), 两周后填数

改:
  src/agent/tools/wait.ts                  +15 行 (Promise.race + enqueue wake)
  src/agent/tools/index.ts                 +2 行 (注册 fetch_reddit + fetch_url)
  src/agent/bot-system-prompt.ts           +20 行 (fetch_reddit 描述 + [空闲行为] 段)
  src/config/index.ts                      +5 行 (BOT_IDLE_HINT_MS / fetch timeouts / fetchLogPath)
  .env.example                             +5 行
  .gitignore                               +1 行 (logs/, 如还没在)
  package.json                             +1 dep (fast-xml-parser, cheerio)
  CLAUDE.md                                +1 段 (idle 行为 + fetch 工具 + NDJSON 旁路日志)

总计 ~370 行新代码 + ~50 行修改, 1 晚到 1 个周末.
```

## Next Steps (实际动手顺序)

1. 写 `ops/fetch-log.ts` + 测试. 30 行, 任何 fetch 工具上来第一件事就是能落日志, 不然两周后没数.
2. 改 `wait.ts` + 写 `wait.test.ts`. 这是核心机制, 优先验证.
3. 写 `fetch-reddit.ts` + 测试. 只 reddit, 不写"通用 feed". 用 fixture, 不打真网. 实现里默认调 fetchLog.
4. 写 `fetch-url.ts` + 测试. 摘要 LLM 在测试里 mock. 实现里默认调 fetchLog.
5. 改 system prompt + 注册工具. 工具描述里"只返回简要"那句话别忘了.
6. 改 env / config / .gitignore (logs/).
7. **创建 `docs/reddit-mvp-review.md`** 占位文档 — 列要看的 4 个数 (一天 fetch 几次 / idle 命中率 / 重复 URL 比例 / 因 fetch 内容真发出的 QQ 消息数). 两周到点了打开它填数, 数填完自然知道下一步加不加表 / 加哪种.
8. 跑 `pnpm test` + `pnpm build`, 全绿.
9. 本地真跑一次 (NAPCAT 真连): 等 30 分钟看是否触发, 看 bot 实际选什么源 / 决策怎么样.
10. 调 `BOT_IDLE_HINT_MS` 到一个真实部署里能接受的值.
11. **设个日历提醒: 14 天后打开 `docs/reddit-mvp-review.md` 填数**. 没这个提醒"两周"会自然滑成"两个月再说".

## 两周复盘 checkpoint

跑 14 天后必须做一次, 数从 NDJSON 跑出来, 填进 `docs/reddit-mvp-review.md`. 那个文档里的指标决定:
- 加不加 `bot_shared_link` 表
- 是不是该升级到子 TaskAgent
- idle 间隔 / compaction 阈值是否调整

不复盘就让这个 MVP 卡在"还行吧"的状态半年, 要么是 bot 实际有用但没数据 backing 改进, 要么是 bot 没用但还在烧 token 没人发现.

## Reviewer Concerns

(留空, 等 codex review / 你审一遍)
