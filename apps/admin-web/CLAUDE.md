# Admin Web Guidelines

## Scope
- This directory is a standalone admin frontend app.
- Only inspect files under this folder when the task explicitly involves designing or modifying `admin-web`.
- For bot/backend tasks, do not read or change files in this folder.

## Tech Stack
- Next.js App Router
- React + TypeScript
- Tailwind CSS + shadcn/ui

## Coding Style
- Keep pages thin. Put reusable UI in `components/`.
- Put shared helpers in `lib/`.
- Prefer server-first rendering unless interactivity is required.

## Non-Goals (Current Stage)
- Do not add bot runtime code here.
