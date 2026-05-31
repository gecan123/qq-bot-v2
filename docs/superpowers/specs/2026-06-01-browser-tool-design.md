# Browser Tool Design

Date: 2026-06-01

## Goal

Give Luna a real browser capability while preserving the single main Agent, perpetual context, prompt-cache stability, and progressive-disclosure principles of `qq-bot-v2`.

The browser should feel like Luna has a real pair of eyes and hands:

- Browse arbitrary websites through a real Chromium session.
- Keep one persistent browser identity and session.
- Read pages, click, type, scroll, screenshot, download resources, and leave local annotations.
- Use routine anti-bot interstitials autonomously when possible.
- Ask the owner for help only when credentials, 2FA, account security, payment, or repeated automation failure requires human intervention.

This spec covers the first implementation slice: one main Agent, one `browser` tool, one local browser sidecar, one persistent profile, and real-browser integration tests.

## Non-Goals

- No browser sub-agent in the first version.
- No site-specific Reddit-only or forum-only tool.
- No natural-language browser task executor hidden behind the tool.
- No remote noVNC or browser profile manager UI in the first version.
- No automatic password, cookie, token, 2FA, or payment handling by the Agent.
- No full DOM, full network log, or full console log injection into the main context.

## Architecture

`qq-bot-v2` registers one `browser` tool. The tool does not launch or control CloakBrowser directly. It calls a local Browser Controller sidecar over loopback HTTP.

```text
BotLoopAgent
  -> ToolExecutor
    -> browser tool
      -> BrowserControllerClient
        -> http://127.0.0.1:<BOT_BROWSER_CONTROLLER_PORT>
          -> Browser Controller sidecar
            -> CloakBrowser launchPersistentContext
              -> headed Chromium window
              -> single persistent Luna profile
              -> multiple pages/tabs
```

The Agent remains the only planner. The Browser Controller only executes single browser actions and returns observations.

### Components

- `browser` tool: the only Agent-facing browser entrypoint. It validates action arguments, calls the controller, clamps text output, and returns stable tool results.
- `BrowserControllerClient`: an internal loopback HTTP client with short timeouts and normalized errors.
- Browser Controller sidecar: owns the CloakBrowser process, persistent profile, page registry, screenshots, downloads, annotations, and browser action audit log.
- Browser artifacts: original screenshots, downloads, and annotations stored on disk under an explicit browser artifact directory.
- `AgentContext`: stores tool results, including screenshot image blocks when the Agent asks for screenshots. It does not depend on controller state for replay.

The tool should only be registered when browser support is configured. If the controller is unavailable at runtime, the tool returns a structured error rather than crashing the bot.

## Browser Tool API

The Agent sees one tool named `browser`. It is a single-step action tool, not a task runner.

Representative schema:

```ts
browser({
  action:
    | "help"
    | "status"
    | "open"
    | "switch_page"
    | "close_page"
    | "observe"
    | "click"
    | "type"
    | "press"
    | "scroll"
    | "screenshot"
    | "download"
    | "annotate"
    | "request_owner_help",
  pageId?: string,
  ...
})
```

The permanent tool description stays short. Detailed usage, action-specific parameters, examples, and limits are disclosed by `browser({ action: "help" })`.

### Actions

- `help`: returns the detailed browser manual.
- `status`: returns controller state, browser state, profile path, active page, and all known pages.
- `open`: opens a URL in the active page or creates a new page when requested.
- `switch_page`: changes the active page.
- `close_page`: closes one page.
- `observe`: returns the default page view: URL, title, load state, page summary, and a capped list of interactive elements with stable `elementId`s.
- `click`: clicks an `elementId`. Coordinate clicking is allowed only as a fallback for pages where element lookup is insufficient.
- `type`: types into a focused element or an explicit `elementId`. It supports append and clear-then-type modes.
- `press`: sends a keyboard key or shortcut, such as `Enter`, `Escape`, or `Meta+L`.
- `scroll`: scrolls the page or a scrollable element by direction and amount.
- `screenshot`: captures the current viewport or full page. It returns a compressed image block in the tool result and saves the original image as an artifact.
- `download`: triggers a download from the current page or an element and stores the file as an artifact, subject to risk checks.
- `annotate`: writes a local annotation about a page, screenshot, download, or source URL.
- `request_owner_help`: records that Luna needs human help for login, 2FA, session recovery, account security, payment, or repeated automation failure.

### Page Model

There is one persistent profile but many pages can be open at once.

- Every page has a `pageId`.
- `status` returns every page with URL, title, active state, load state, and `lastUsedAt`.
- Actions default to the active page unless a `pageId` is provided.
- `open` can reuse the active page or create a new page.
- `switch_page` changes the active page without changing page content.
- `close_page` closes a page but does not clear the profile or session.

The main Agent still calls tools serially. Multi-page support means the browser can preserve several tabs, background loads, and downloads while the Agent advances them one step at a time.

## Profile And Session

The first version uses one persistent browser profile for Luna. The profile stores cookies, localStorage, IndexedDB, cache, extensions, and browser history.

Default profile path:

```text
data/browser-profile/luna/
```

The Browser Controller starts CloakBrowser with `launchPersistentContext` in headed mode. The owner can directly operate the visible browser window on the Mac when human help is needed.

The Agent does not receive raw cookies, localStorage, passwords, tokens, or profile files. It only uses session state through normal page interactions.

### Owner Handoff

Owner handoff is not for routine browsing friction. Luna should first try to handle normal browser work herself:

- Cloudflare or Turnstile interstitials.
- "I am human" single-click checks.
- Cookie consent.
- Age or region confirmation.
- Ordinary popups, continue buttons, and content expansion.

Luna asks the owner only for:

- Username/password login that is not already available in the session.
- 2FA, SMS, email verification, passkeys, or device approval.
- Account security changes.
- OAuth authorization of a real account.
- Payment or purchase flows.
- Identity or private-document upload.
- Repeated challenge failure or account-risk pages.

The normal flow is:

1. Luna observes that human help is required.
2. Luna calls `browser({ action: "request_owner_help", ... })`.
3. The tool returns `requiresOwnerHelp: true`.
4. Luna uses existing `send_message` to privately ask the owner for help.
5. The owner completes the login or recovery in the visible browser window.
6. Luna continues with `observe` on the same page/profile.

## Risk Policy

Risk checks live in the Browser Controller, not only in prompt wording.

### Low Risk: Allow

- Open, read, search, scroll, expand, navigate.
- Cookie consent and ordinary popups.
- Routine anti-bot interstitials.
- Screenshots.
- Reading and copying public text.

### Normal Risk: Allow And Audit

- Filling ordinary forms.
- Posting, commenting, liking, following, starring, bookmarking, or uploading ordinary text/images.
- Using sites that welcome AI agents or normal community participation.

These are part of the desired human-like browser capability. They are allowed by default and recorded in the browser action audit log.

### High Risk: Require Owner Help

- Payment, purchase, subscription, refunds, or financial actions.
- Password, email, 2FA, passkey, recovery, or account security settings.
- OAuth authorization for third-party apps.
- Exporting large amounts of private data.
- Deleting accounts, repositories, posts, or important user content.
- Downloading or running executables, installers, scripts, or suspicious archives.
- Uploading identity documents or private material.
- Repeated challenge failure or account-risk pages.

On high risk, the controller returns a structured refusal:

```json
{
  "ok": false,
  "requiresOwnerHelp": true,
  "risk": "account_security",
  "reason": "The page asks for a 2FA code."
}
```

### Detection Inputs

The first version uses conservative heuristics from:

- Element text and `aria-label`.
- Form field names, labels, placeholders, and autocomplete values.
- Current URL, domain, and path.
- File extension, MIME type, and download filename.
- Page title and nearby text around the target element.

Sensitive values such as passwords, tokens, cookies, authorization headers, card numbers, and 2FA codes are never returned to the LLM and never written to logs.

## Context And Artifacts

The design follows the perpetual context contract: tool results appended to `AgentContext` are historical facts. The browser tool must not mutate, replace, delete, or summarize older browser tool results. History slimming is only allowed through the formal compaction path.

### Observe

`observe` is the default cheap visual substitute. It returns a short, deterministic textual observation:

- URL.
- Title.
- Page load state.
- Capped page summary.
- Capped interactive element list.
- Stable element IDs valid until the next observation or page mutation.

It does not include a screenshot by default.

### Screenshot

`screenshot` is the visual memory path.

- It returns metadata plus a compressed image block in the tool result.
- The image block is appended to `AgentContext`, so Luna can keep seeing the screenshot in future rounds as part of the stable history.
- The original full-resolution image is also saved as an artifact.
- The artifact is for audit, review, sending, or later re-reading. It is not a substitute for the LLM history.

This intentionally preserves the meaning of screenshots. Converting every screenshot to text would lose layout, relative position, visual obstruction, icons, colors, and image content.

### Downloads

Downloads are for resources behind or linked from web pages, not for ordinary page reading.

Examples:

- Original images rather than rendered thumbnails.
- PDFs, reports, papers, and manuals.
- Text, CSV, JSON, Markdown, logs, and other attachments.
- Web snapshots for evidence when a page may change.
- Dev debugging outputs such as exported files, HAR, traces, or generated reports.
- Materials that Luna may later send through `send_message`.

Downloads are saved under the browser artifact directory and return artifact references, metadata, size, content type, and source URL. High-risk file types require owner help.

### Annotations

`annotate` writes local notes about pages or artifacts. It does not post to the website.

Representative path:

```text
data/agent-workspace/browser/annotations/<domain>/<artifactId>.md
```

Annotations are page-specific marginalia. They do not replace `write_journal`, which remains Luna's general diary/thought tool.

## Logging

Each browser action writes an NDJSON audit entry, separate from Prisma and separate from `AgentContext`.

Representative path:

```text
logs/browser-actions.ndjson
```

Fields include:

- Timestamp.
- Action.
- Page ID.
- URL and title.
- Target element summary or coordinates.
- Risk level and risk reason.
- Result status.
- Artifact IDs.
- Error code, when any.

The existing tool-call log still records the top-level `browser` tool call. The browser action log records browser-specific details.

Logs must redact sensitive fields, identifiers, cookies, tokens, passwords, 2FA codes, payment fields, and long typed text when appropriate.

## Errors And Recovery

The browser tool returns structured errors and never crashes the bot.

- `browser_controller_unavailable`: sidecar is not running or not reachable.
- `browser_start_failed`: controller could not start CloakBrowser.
- `browser_crashed`: browser process died; controller should attempt recovery on the next action.
- `page_not_found`: the page was closed or the page ID is stale.
- `element_stale`: the element ID is no longer valid; Luna should call `observe`.
- `navigation_timeout`: navigation is still loading or timed out; result includes current URL and load state.
- `download_blocked`: download risk policy blocked the file.
- `requires_owner_help`: high-risk or human-required state.

Recovery entrypoints:

- `status` to inspect controller/browser/page state.
- `observe` to rebuild element IDs.
- `open` to create a new page.
- owner handoff when session or account state requires human input.

Artifacts and audit logs survive controller restarts. AgentContext replay does not re-run browser actions; it replays the original tool result bytes.

## Configuration

Expected environment variables:

- `BOT_BROWSER_ENABLED`: registers the `browser` tool when true.
- `BOT_BROWSER_CONTROLLER_URL`: loopback URL, for example `http://127.0.0.1:37921`.
- `BOT_BROWSER_PROFILE_DIR`: persistent profile path, default `data/browser-profile/luna`.
- `BOT_BROWSER_ARTIFACT_DIR`: screenshots/downloads/annotations path, default `data/agent-workspace/browser`.
- `BOT_BROWSER_ACTION_LOG_PATH`: browser action audit log, default `logs/browser-actions.ndjson`.
- `BOT_BROWSER_ACTION_TIMEOUT_MS`: per-action timeout.

These names are part of the design. Implementation should wire them through `src/config/index.ts` and document them in `.env.example`.

## Testing And Verification

The core verification uses a real Browser Controller and a real CloakBrowser instance against local fixture pages. Mock-based tests are not the main acceptance path because this feature's risk is in real browser behavior.

### Real Browser Integration Tests

Start the controller and a real persistent CloakBrowser profile, then use local HTML fixtures to verify:

- `open -> observe -> click -> type -> press -> scroll -> screenshot -> download`.
- Each step has a short timeout, for example 5-15 seconds. A hang is a failure.
- `screenshot` returns an image block and saves the original artifact.
- `download` saves safe files and blocks high-risk files.
- `observe` output is capped.
- Element IDs work after observation and become recoverable with a new observation if stale.

### Multi-Page Tests

- Open two fixture pages.
- `status` lists both pages.
- `switch_page` changes the active page.
- Actions with explicit `pageId` apply to the correct page.
- `close_page` updates the page registry.

### Risk Tests

Fixture pages include representative controls:

- "Post comment" should be allowed and audited.
- "Pay now" should require owner help.
- "Connect OAuth" should require owner help.
- "Change password" should require owner help.
- "Download .dmg" or similar high-risk downloads should be blocked.
- Ordinary cookie consent and "I am human" buttons should be allowed.

### Context Tests

Use real `browser` tool results where possible:

- Append a screenshot result to `AgentContext`.
- Export the snapshot.
- Confirm the snapshot is byte-stable for the same appended result.
- Confirm the browser tool does not mutate prior messages.

### Manual External-Site Verification

External sites are not stable CI dependencies. They are manual acceptance checks:

- Open a real site.
- Let Luna handle routine anti-bot interstitials.
- Use owner handoff for login/session repair.
- Verify session persistence after controller restart.
- Verify a normal post/comment on an AI-welcoming test site.
- Check `logs/browser-actions.ndjson` and `logs/tool-calls.ndjson`.

## Implementation Decisions

- The sidecar entrypoint is `scripts/browser-controller.ts`.
- Shared controller/client/types modules live under `src/browser/**`.
- Local protocol types live in `src/browser/protocol.ts` and are shared by the tool and sidecar.
- The profile directory `data/browser-profile/` must be gitignored.
- Verify CloakBrowser JavaScript package API and persistent context support in the target environment before coding the launcher.
- Keep tool descriptions short and use `action:"help"` for detailed progressive disclosure.
