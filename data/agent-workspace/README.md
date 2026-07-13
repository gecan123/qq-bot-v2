# Agent Workspace

This directory is the bot/agent-owned workspace. Managed knowledge is split by lifetime and purpose:

- `memory/`: stable facts, preferences, methods, and conclusions that can be reused directly.
- `notebook/<kind>/YYYY-MM.md`: evolving research, reading, market, project, or general topic work.
- `life/journal/YYYY-MM-DD.md`: selective reflections and dreams.
- `life/agenda.md`: mutable commitments, waiting items, unfinished interests, and concrete next steps.
- Other directories: ordinary drafts, scratch notes, indexes, runtime state, and managed artifacts.

Managed paths are written through their typed tools. Deferred `workspace_file` is only for ordinary text files, while `workspace_bash cwd=workspace` is a read-only inspection surface plus controlled built-in subcommands. The legacy `journal/` directory is no longer used and exists only as a reset cleanup target.

Markdown files under `memory/`, `notebook/`, and `life/` are the source of truth. There is currently no SQLite, FTS/BM25, embedding, vector index, or hidden automatic memory injection. The main agent explicitly calls `memory recall` when prior facts are relevant; returned results enter the durable AgentContext ledger and are not re-read from mutable Markdown during replay.

Run `pnpm agent:memory-check` from the repository root for a read-only structural report. It must not create or repair workspace state.

Runtime contents are ignored by git by default. Commit only the directory contract files (`README.md` and `.gitignore`) unless a human explicitly decides a generated artifact should become project documentation.
