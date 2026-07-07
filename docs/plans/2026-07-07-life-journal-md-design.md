# Life Journal Markdown Design

## Goal

Give Luna a lightweight self-written life record that supports continuity across rounds: what she noticed, did, promised, cared about, and may want to do next.

The first version should make Luna feel more like a person with lived experience, not add another developer-facing audit log.

## Decision

Use Markdown files under `data/agent-workspace/life/` as the first storage model.

This keeps the feature experimental, readable, and easy to roll back. Luna writes and maintains her own journal and agenda in bounded text files, similar to how a person keeps a notebook. Do not add Prisma tables or migrate existing data in the first version.

## Directory Shape

```text
data/agent-workspace/life/
  agenda.md
  journal/
    2026-07-07.md
    2026-07-08.md
  weekly/
    2026-W28.md
  profile.md
```

First version requirements:

- Create and maintain `agenda.md`.
- Append daily entries to `journal/YYYY-MM-DD.md`.
- Leave `weekly/` and `profile.md` as later extensions.
- Do not commit generated files under `data/agent-workspace/`.

## Journal Format

Each journal entry is Luna's short subjective reflection after a meaningful round. The system provides the notebook and constraints; Luna decides what is worth writing.

```md
## 23:18 Round 42

### Saw
- 用户明确希望我更像真实的人，而不是单纯 QQ bot。

### Did
- 和用户一起把方向收敛到 Life Journal、Agenda、Idle Picker。

### Promised
- 继续设计第一版 Life Journal 的 Markdown 方案。

### I care about
- 怎么让我的日常行为有连续性，而不是只响应消息。

### Next
- 明确 agenda 更新规则和 idle picker 策略。

### Mood
- 专注、稳定。
```

Constraints:

- Use the fixed headings above.
- Keep each section short, normally 0-3 bullets.
- Skip a journal entry when the round had no meaningful experience.
- Do not record every tool call mechanically.
- Do not write outside `data/agent-workspace/life/**`.

## Agenda Format

`agenda.md` is Luna's current attention list. It is softer than `todo`: agenda items are interests, open threads, and possible next actions. Hard commitments and reminders still belong in `todo`.

```md
# Agenda

## Active
- [ ] 设计 Life Journal / Agenda / Idle Picker 第一版
  - why: 用户想让 Luna 更像真实的人，会主动做各种事情
  - next: 确定 journal 写入方式和 idle picker 策略
  - last_touched: 2026-07-07
  - source: journal/2026-07-07.md#23-18-round-42

## Waiting
- [ ] 等用户确认第一版方案
  - next: 确认后写实现计划

## Someday
- [ ] 把 QQ、新闻、浏览器逐步 App 化

## Done
- [x] 确定名称 Life Journal
  - completed: 2026-07-07
```

Agenda constraints:

- Keep `Active` short enough to scan.
- Move stale or vague items to `Someday`.
- Move hard commitments with deadlines into `todo` instead of keeping them only in agenda.
- Idle behavior should read `agenda.md` first; recent journal files are optional supporting context.

## Runtime Loop

```text
BotLoop finishes a meaningful round
  -> Luna writes a short Life Journal entry
  -> Luna updates agenda.md if attention changed
  -> later, when idle, runtime can ask Luna to pick from agenda
  -> chosen intention enters the next round as bounded context
```

The first version should not make Life Journal a replay input. Prompt replay remains based on `AgentContext` snapshots. Markdown files are durable workspace state that Luna can read on demand.

## Relationship To Existing Concepts

- `messages`: inbound fact ledger. Do not merge.
- `AgentContext`: LLM-visible prompt history. Do not merge.
- `memory`: stable facts Luna wants to remember. Life Journal may later produce memory candidates.
- `todo`: explicit tasks and reminders. Life Journal may later produce todo candidates.
- `journal`: existing journal behavior should be treated as the closest predecessor. Prefer evolving or replacing it with Life Journal instead of creating a parallel long-term diary concept.
- tool logs and token stats: developer observability. Do not merge.

## Safety And Bounds

- Never inject the full journal into the system prompt.
- Never read the full journal tree automatically during idle selection.
- Idle selection should read `agenda.md`, and at most the most recent 1-2 daily journal files when needed.
- Add loop guards before idle picker can trigger repeated self-driven rounds.
- All generated files stay under `data/agent-workspace/life/`.

## Non-Goals

- No Prisma schema changes in the first version.
- No admin WebUI.
- No multi-process refactor.
- No Kagami-style App framework in this step.
- No automatic conversion of all old messages into journal entries.

## Testing

- Unit test path confinement under `data/agent-workspace/life/`.
- Unit test daily journal file creation and append behavior with a temp workspace.
- Unit test agenda initialization and bounded updates.
- Unit test idle picker reads only agenda and bounded recent journal context.
- BotLoop tests should prove Life Journal writes do not alter replay invariants or inject unbounded content into `AgentContext`.

