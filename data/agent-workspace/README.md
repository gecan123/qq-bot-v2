# Agent Workspace

This directory is the bot/agent-owned workspace.

Files created here are produced by agents through dedicated managed-data tools or deferred `workspace_file`: journals, dreams, scratch notes, indexes, drafts, and other self-organized working files. `workspace_bash cwd=workspace` is a read-only inspection surface plus controlled built-in subcommands.

Runtime contents are ignored by git by default. Commit only the directory contract files (`README.md` and `.gitignore`) unless a human explicitly decides a generated artifact should become project documentation.
