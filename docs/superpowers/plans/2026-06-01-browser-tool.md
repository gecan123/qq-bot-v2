# Browser Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Luna's first real-browser capability: one main-Agent `browser` tool backed by a local CloakBrowser sidecar, one persistent profile, multi-page support, screenshots in AgentContext, artifacts, audit logs, and real-browser fixture verification.

**Architecture:** The bot registers a single `browser` tool when `BOT_BROWSER_ENABLED=true`. The tool calls a loopback Browser Controller sidecar (`scripts/browser-controller.ts`) through shared typed protocol modules in `src/browser/**`. The sidecar owns a headed persistent CloakBrowser context, page registry, risk checks, artifacts, and browser action logging.

**Tech Stack:** TypeScript ESM, zod, Node HTTP server/client, CloakBrowser Playwright API, sharp screenshot compression, Node test runner, local fixture HTML pages.

---

## File Structure

- Create `src/browser/protocol.ts`: shared action/result types, zod schemas, clamps, constants.
- Create `src/browser/risk.ts`: conservative risk classifier for clicks, typing, and downloads.
- Create `src/browser/action-log.ts`: browser action NDJSON logger with redaction.
- Create `src/browser/controller.ts`: Browser Controller core using CloakBrowser and Playwright-compatible APIs.
- Create `src/browser/server.ts`: loopback HTTP server wrapping `BrowserController`.
- Create `src/browser/client.ts`: bot-side HTTP client.
- Create `src/agent/tools/browser.ts`: single Agent-facing `browser` tool.
- Modify `src/agent/tools/index.ts`: conditionally register `browser`.
- Modify `src/config/index.ts`: parse browser env.
- Modify `.env.example`, `.gitignore`, `package.json`.
- Create `scripts/browser-controller.ts`: sidecar entrypoint.
- Create `src/browser/fixtures/*`: local HTML fixtures for real-browser verification.
- Create tests under `src/browser/*.test.ts` and `src/agent/tools/browser.test.ts`.

## Tasks

### Task 1: Protocol, Config, Dependency, Plan Commit

**Files:**
- Create: `src/browser/protocol.ts`
- Modify: `src/config/index.ts`
- Modify: `.env.example`
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `docs/superpowers/plans/2026-06-01-browser-tool.md`

- [ ] Add `cloakbrowser` dependency with `pnpm add cloakbrowser playwright-core`.
- [ ] Add `.gitignore` entry for `data/browser-profile/`.
- [ ] Add browser env examples to `.env.example`.
- [ ] Extend `parseConfig()` with:
  - `browser.enabled`
  - `browser.controllerUrl`
  - `browser.profileDir`
  - `browser.artifactDir`
  - `browser.actionLogPath`
  - `browser.actionTimeoutMs`
- [ ] Create `src/browser/protocol.ts` with action schemas and result types.
- [ ] Run `pnpm typecheck`.
- [ ] Commit plan/protocol/config changes.

### Task 2: Risk Classifier And Audit Log

**Files:**
- Create: `src/browser/risk.ts`
- Create: `src/browser/risk.test.ts`
- Create: `src/browser/action-log.ts`
- Create: `src/browser/action-log.test.ts`

- [ ] Write tests for low/normal/high click labels: "I am human", "Post comment", "Pay now", "Connect OAuth", "Change password".
- [ ] Write tests for high-risk downloads: `.dmg`, `.pkg`, `.exe`, `.sh`, suspicious archives.
- [ ] Implement `classifyBrowserActionRisk()`.
- [ ] Write tests for audit redaction of password/token/cookie/2FA/payment-like fields.
- [ ] Implement `logBrowserAction()` with appendFile, mkdir, failure swallowing, and test reset helper.
- [ ] Run `pnpm test src/browser/risk.test.ts src/browser/action-log.test.ts`.
- [ ] Commit risk and audit modules.

### Task 3: Browser Controller And Sidecar

**Files:**
- Create: `src/browser/controller.ts`
- Create: `src/browser/server.ts`
- Create: `scripts/browser-controller.ts`
- Create: `src/browser/fixtures/basic.html`
- Create: `src/browser/fixtures/download.txt`
- Create: `src/browser/controller.test.ts`

- [ ] Implement Browser Controller lifecycle: lazy launch, status, page registry, active page.
- [ ] Implement actions: `help`, `status`, `open`, `switch_page`, `close_page`, `observe`, `click`, `type`, `press`, `scroll`, `screenshot`, `download`, `annotate`, `request_owner_help`.
- [ ] Implement artifact paths under `BOT_BROWSER_ARTIFACT_DIR`.
- [ ] Implement screenshot compression with existing `compressForContext()`.
- [ ] Implement loopback HTTP server with `POST /action` and `GET /health`.
- [ ] Implement `scripts/browser-controller.ts`.
- [ ] Add real-browser fixture integration test with short timeouts.
- [ ] Run `pnpm test src/browser/controller.test.ts`.
- [ ] Commit controller and sidecar.

### Task 4: Agent Tool And Registration

**Files:**
- Create: `src/browser/client.ts`
- Create: `src/agent/tools/browser.ts`
- Create: `src/agent/tools/browser.test.ts`
- Modify: `src/agent/tools/index.ts`
- Modify: `src/ops/tool-call-log.ts`
- Modify: `docs/current-state.md`

- [ ] Implement `BrowserControllerClient`.
- [ ] Implement `maybeCreateBrowserTool()` with one `browser` tool and zod schema.
- [ ] Ensure screenshot image blocks pass through as tool result content.
- [ ] Register the tool only when `config.browser.enabled` is true.
- [ ] Mark `browser` as side-effecting in `isSideEffectTool()`.
- [ ] Update current-state docs with the new optional browser capability.
- [ ] Run `pnpm test src/agent/tools/browser.test.ts`.
- [ ] Commit tool registration.

### Task 5: Verification, Self-Review, Fixes

**Files:**
- Modify files found during review.

- [ ] Run `pnpm typecheck`.
- [ ] Run focused browser/tool tests.
- [ ] Run `pnpm test`.
- [ ] Run `git diff --check`.
- [ ] Self-review implementation against `docs/superpowers/specs/2026-06-01-browser-tool-design.md`.
- [ ] Fix any review findings.
- [ ] Re-run failed or impacted verification.
- [ ] Commit final fixes.
