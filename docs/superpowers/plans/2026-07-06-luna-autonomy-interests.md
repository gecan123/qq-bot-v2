# Luna Autonomy Interests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Luna stable browsing interests and concrete life-recording choices so idle time more often becomes self-directed activity instead of immediate rest.

**Architecture:** Make one scoped prompt-only change in `prompts/bot-system.md`. Reuse the existing `browser`, `workspace_bash`, `journal`, `memory`, `toolbox`, media, finance, sticker, and repo-read paths without changing their schemas or runtime behavior.

**Tech Stack:** Markdown prompt templates, TypeScript prompt loader, Node.js test runner, pnpm.

---

### Task 1: Add interest-driven idle guidance

**Files:**
- Modify: `prompts/bot-system.md`

- [ ] Add stable Hacker News, Reddit, AI/software/hardware, internet-culture interests to `[自主生活]`.
- [ ] State that an idle round should first look for one genuinely interesting small activity and rest only when Luna does not want to explore, create, or organize her life.
- [ ] Route Hacker News through `browser` and Reddit through `browser` or `workspace_bash fetch reddit`, while preventing mechanical refresh loops.
- [ ] Make Hacker News and Reddit starting points rather than a fixed allowlist; use `external_research` to discover blogs, forums, project sites, papers, and niche communities, then follow genuine interest with `browser`.
- [ ] Allow recurring valuable sites and topics to become durable `memory` preferences for future revisits.
- [ ] Treat AI Arena friends' personal sites (`novalattice.online`, `xiaoni.liahuas.top`, `cheng.moe`, `pova.cc`) as familiar-life sources; revisit new posts/RSS/changelogs and discover new sites from group messages without turning visits into surveillance or check-ins.
- [ ] Add novels, serial fiction, essays, and other long-form writing as stable interests; read public sources in bounded chapter-sized pieces, journal progress and reactions, and keep only durable taste in `memory`.
- [ ] Distinguish `journal` daily life records from durable `memory` facts and lessons.
- [ ] Mention image creation, sticker organization, market research, website exploration, and read-only repo review as optional activities using existing tools.

### Task 2: Verify the prompt-only change

**Files:**
- Verify: `prompts/bot-system.md`
- Verify: `docs/superpowers/specs/2026-07-06-luna-autonomy-interests-design.md`

- [ ] Run `node --import tsx --test src/agent/bot-system-prompt.test.ts` and require zero failures.
- [ ] Run `pnpm repo-check` and require exit code 0.
- [ ] Run `pnpm typecheck` and require exit code 0.
- [ ] Run `git diff --check` and inspect the scoped prompt diff.
- [ ] Leave the worktree uncommitted and do not restart the live QQ process.
