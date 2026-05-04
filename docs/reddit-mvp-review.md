# Idle-Fetch MVP — 两周复盘

Status: PLACEHOLDER (待填)
设计文档: `docs/idle-fetch-mvp.zh-CN.md`
开始跑的日期: ____________  (TODO: ship 当天填)
复盘日期: ____________      (= 开始 + 14 天)

---

这个文档是在 ship MVP 之前**预先**建好的, 防止"两周后再看"自然滑成"两个月再说". 14 天到点了打开这里, 跑下面的命令把数填进去, 然后根据数据决定下一步.

## 关键指标 (NDJSON 跑出来)

NDJSON 路径: `logs/fetch.ndjson` (或 `BOT_FETCH_LOG_PATH` 覆盖). 一行一次 fetch 调用.

### 1. 每天 fetch 次数 (体感:bot 多积极)

```bash
jq -r '.ts | .[0:10]' logs/fetch.ndjson | sort | uniq -c | sort -k2
```

预期:
- 健康范围: 5-30 次/天 (idle 30min × 48 次/天的上限, 但很多次会被 LLM 选择继续 wait)
- 异常高 (>50/天): bot 太焦虑, 调高 `BOT_IDLE_HINT_MS` 或在 system prompt 里加压
- 异常低 (<2/天): idle 提示对 LLM 太弱, 看是不是 system prompt 没鼓励够

实测: __________ 次/天 (中位数)
观察: __________

### 2. idle 命中率 (理论上限 vs 实际触发)

每天理论 idle 触发上限 = 24 × 60 / (BOT_IDLE_HINT_MS 分钟). 默认 30min → 上限 48 次.
实际 idle 触发数 = NDJSON 里第一条紧跟 idle hint 的 fetch 调用次数 (近似 — 真要精确得在 wait.ts 也写日志, MVP 用 fetch 数量近似).

```bash
# fetch 总数 / 理论 idle 上限
echo "scale=2; $(wc -l < logs/fetch.ndjson) / 14 / 48" | bc
```

预期:
- 0.1-0.5: 大部分 idle 时 bot 选择继续 wait, 健康
- > 0.7: bot 几乎每次 idle 都 fetch, 可能太冲动
- < 0.05: idle 触发了但 bot 几乎不刷, system prompt 没引导对

实测: __________ (比例)
观察: __________

### 3. 重复 URL 比例 (compaction 之后是否再发同一条)

```bash
# 出现次数 > 1 的 URL 比例
total=$(wc -l < logs/fetch.ndjson)
dup=$(jq -r .url logs/fetch.ndjson | sort | uniq -c | awk '$1 > 1 {n+=$1-1} END {print n}')
echo "scale=3; $dup / $total" | bc
```

预期:
- < 5%: in-context 历史足够, dedup 不需要表
- 5-15%: 边缘地带, 可加 light 表 (`bot_shared_link`)
- > 15%: bot 在反复刷同一篇, 必须加 dedup 机制

具体看哪些 URL 重复最多:
```bash
jq -r .url logs/fetch.ndjson | sort | uniq -c | sort -rn | head -20
```

实测: __________ % 重复
最重复的 URL: __________
观察: __________

### 4. fetch 内容真的让 bot 发出了 QQ 消息的比例 (signal-to-noise)

NDJSON 不直接记 send_message, 这个数要从 bot snapshot / 实际行为反推. 简化做法:

```bash
# 当天 fetch 数
day=$(date +%Y-%m-%d)
fetches=$(jq -r 'select(.ts | startswith("'$day'")) | .url' logs/fetch.ndjson | wc -l)

# 当天 bot 实际 send 出去的消息条数 (从 NapCat 日志或 admin grep)
# TODO: 想个具体命令, MVP 阶段最简单是手动数那天它发了几条主动消息
```

或者: ship 时给 send_message 工具也加一行 NDJSON 到 `logs/send.ndjson`, 字段 `{ts, target, len, has_url}`. 然后:

```bash
jq -s '[.[] | select(.has_url == true)] | length' logs/send.ndjson
```

预期 fetch:send-with-url 比例:
- 1:0.3 ~ 1:0.5: bot 看完决定不分享是健康的, 有判断力
- 1:0.05 以下: bot 抓了不分享, 像在自闭症式刷, 可能没必要
- 1:1 接近: bot 抓了几乎都分享, 缺判断力, 可能在强行找话说

实测 fetch / send-with-url 比例: __________
观察: __________

## 主观判断 (用一周时间用感觉打分, 1-10)

- bot 主动分享的内容 **质量** (1=毫无品味的爆款 slop, 10=经常让你想说"诶这个不错"): __________
- bot 主动分享的 **频率** 是否合适 (1=太烦人 / 10=完全注意不到 / 5=刚好): __________
- bot 选的 **subreddit** 是否合理 (它常用哪些 sub? 是否一直钉死在一两个? 是否选了个该群完全无关的): __________
- bot 是否会 **看人下菜** (在不同群推不同 sub 的内容, 还是无差别撒): __________

## 决定 (填完上面的数再来决定, 不要提前回答)

基于上面数据, 下一步选一个:

- [ ] **A. 不动**, 这个 MVP 已经足够好, 接着用. 数据指标都在健康区.
- [ ] **B. 调参不改架构**:
  - [ ] BOT_IDLE_HINT_MS 改成 ____________
  - [ ] COMPACTION_TRIGGER_TOKENS 改成 ____________
  - [ ] system prompt 调整: ____________
- [ ] **C. 加 light 表 `bot_shared_link`** — 仅当重复 URL 比例 > 5% 才加
- [ ] **D. 加 heavy 表 `bot_fetch_log`** — 仅当需要分析 "fetch 了但没分享" 的内容才加
- [ ] **E. 升级到真子 TaskAgent** — 仅当 fetch_url 摘要质量明显不够 (你看到分享 → 觉得 bot 误读了原文)
- [ ] **F. 加新源 (v2ex / HN / ...)** — 仅当 reddit 被 bot 用得起劲 + 内容质量数据健康. reddit 都没人用就别加了.
- [ ] **G. 砍掉 idle-fetch** — 数据显示 bot 主动分享比 wait 还烦人

## 复盘后

把这文档归档到 `docs/archive/`, 或者直接在这文档底部继续追加下一轮 checkpoint (一个月后再看?). 不要让这文档烂尾.
