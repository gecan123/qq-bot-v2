# Memory Architecture Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Document the current memory architecture after Journal-to-Notebook consolidation and identify the next consistency improvements.

**Architecture:** Add one dedicated stable architecture document, link it from existing entry points, and keep tool-level details in `docs/TOOLS.md`. Treat inbound facts, the durable LLM ledger, and workspace side-data as distinct layers.

**Tech Stack:** Markdown, Mermaid, repository checks.

---

### Task 1: Add the dedicated memory architecture document

**Files:**
- Create: `docs/MEMORY_ARCHITECTURE.md`

1. Add the state inventory table and explicit non-memory boundaries.
2. Add the ingress, disclosure, write, maintenance, and reset data flows.
3. Add the write-routing decision table and storage formats.
4. Add replay, revision, concurrency, and failure invariants.
5. Record prioritized improvements without implementing them.

### Task 2: Link the architecture from stable entry points

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

1. Add `docs/MEMORY_ARCHITECTURE.md` to the knowledge map.
2. Link it from the persistent-boundary section in the general architecture.
3. Add it to the repository priority-reading list while keeping both instruction files byte-identical.

### Task 3: Refresh technical-debt status

**Files:**
- Modify: `docs/TECH_DEBT.md`

1. Remove the completed legacy `MemoryEntry` cleanup item.
2. Add the Life Journal/Agenda revision and serialization risk.
3. Add the overly broad reset command naming/scope issue.

### Task 4: Verify documentation consistency

1. Run `cmp -s AGENTS.md CLAUDE.md`.
2. Run `pnpm repo-check`.
3. Run `git diff --check`.
4. Search current documentation for stale claims that ordinary `journal` remains active or `MemoryEntry` still exists.
