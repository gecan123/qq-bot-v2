# Admin Web Guidelines

## Scope
- This directory is a standalone admin frontend app.
- When asked for frontend-only work, focus only on files under this folder.

## Tech Stack
- Next.js App Router
- React + TypeScript
- Tailwind CSS + shadcn/ui

## Coding Style
- Keep pages thin. Put reusable UI in `components/`.
- Put shared helpers in `lib/`.
- Prefer server-first rendering unless interactivity is required.

## Non-Goals (Current Stage)
- Do not add database access in pages.
- Do not add bot runtime code here.
