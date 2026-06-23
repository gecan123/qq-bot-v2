# Workspace Journal Design

## Goal

Move Luna's journal and dream storage toward the private workspace model while keeping progressive disclosure and a semantic tool boundary.

## Decision

Do not merge journal behavior into raw `workspace_bash`. Keep `workspace_bash` as the low-level, allowlisted file tool, and keep a high-level journal tool as the normal LLM interface. The journal tool should read and write bounded files under `data/agent-workspace/journal/`.

This gives Luna a real private workspace for durable self-written content without asking the model to maintain file format, truncation, search, and disclosure rules through shell commands.

## Shape

- Keep the user-facing tool name `write_journal` for now to avoid tool churn.
- Extend its implementation to use workspace-backed files instead of Prisma `JournalEntry`.
- Store entries under `data/agent-workspace/journal/`, outside project source and excluded from commits.
- Use a machine-readable append-only format, preferably JSONL, so list/search/read can be deterministic.
- Return only short previews for list/search. Full content should require an explicit read action.
- Leave `workspace_bash` available for ad hoc private workspace organization, but not as the primary journal API.

## Actions

Recommended `write_journal` actions:

- `write`: append `{ id, kind, content, createdAt }`.
- `list`: return recent entries by kind with short previews.
- `search`: keyword search with bounded results and short previews.
- `read`: return one full entry by id.

## Data Flow

1. LLM calls `write_journal`.
2. Tool reads or appends files under `data/agent-workspace/journal/`.
3. Tool result returns bounded structured JSON.
4. Only that tool result enters `AgentContext`.

The workspace files are durable facts, but they do not reconstruct prompt history. Replay remains based on `AgentContext`, not workspace state.

## Error Handling

- Corrupt JSONL lines should be skipped with a warning count in tool output.
- Missing journal files should behave like an empty journal.
- Read by unknown id should return `{ ok:false }`.
- Writes should create directories as needed.
- Search/list limits should stay capped at 20.

## Migration

No historical migration is required for this experimental project unless explicitly requested. If needed later, a one-off script can export `JournalEntry` rows to JSONL.

## Non-Goals

- Do not expose raw shell as the journal interface.
- Do not add admin WebUI.
- Do not put full journal content into system prompt or compaction summaries automatically.
- Do not commit generated journal files under `data/agent-workspace/`.

## Testing

- Unit test file creation and append behavior with a temp workspace directory.
- Unit test list/search/read bounds and preview truncation.
- Unit test corrupt JSONL tolerance.
- Keep existing compatibility for old `{ kind, content }` write args and current `action=write/list/search`.
