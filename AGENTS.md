# Repository Guidelines

## Project Structure & Module Organization
Core application code lives in `src/`:
- `src/index.ts` boots the process, database connection, and shutdown hooks.
- `src/bot/` contains NapCat integration and message parsing.
- `src/database/` contains Prisma client wiring and message persistence.
- `src/config/`, `src/types/`, and `src/logger.ts` hold shared config, types, and logging utilities.

Database schema is in `prisma/schema.prisma`. Generated client code is emitted to `src/generated/prisma/`. Build output goes to `dist/` and should not be edited manually.

## Build, Test, and Development Commands
- `pnpm dev`: Run the bot in watch mode via `tsx`.
- `pnpm build`: Compile TypeScript to `dist/` with `tsc`.
- `pnpm start`: Run compiled output (`dist/index.js`).
- `pnpm db:generate`: Regenerate Prisma client after schema changes.
- `pnpm db:migrate`: Create/apply local Prisma migrations.
- `pnpm db:push`: Push schema directly to DB (useful for fast local iteration).

## Coding Style & Naming Conventions
Use TypeScript with ES modules (`.js` import suffixes in source imports). Prefer:
- `camelCase` for variables/functions, `PascalCase` for types/interfaces, `SCREAMING_SNAKE_CASE` for env keys.
- Small, single-purpose modules under `src/`.
- Strict typing; avoid `any` unless unavoidable and justified.

Formatting/linting tools are not configured yet. Keep style consistent with nearby files and run `pnpm build` before committing.

## Testing Guidelines
No automated test runner is configured currently. For now:
- Treat `pnpm build` as the minimum CI gate.
- Validate bot flow manually in a dev QQ group and verify DB inserts.
- If you add tests, place them near source as `*.test.ts` or in `tests/`, and document the command in `package.json`.

## Commit & Pull Request Guidelines
Follow the existing Conventional Commit pattern seen in history:
- `feat: ...`
- `fix: ...`
- `chore: ...`

PRs should include:
- Clear summary of behavior changes.
- Linked issue/task (if applicable).
- Config or schema impact (`.env`, Prisma) and rollout notes.
- Logs/screenshots for observable bot behavior changes when relevant.
