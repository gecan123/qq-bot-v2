# Luna Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deferred `website` capability so Luna can maintain an owner-provisioned Astro site repository, check it, commit allowed content changes, and push to the configured production branch.

**Architecture:** Keep the website repo separate from `qq-bot-v2`; `qq-bot-v2` only exposes a narrow tool around that repo. The tool has a fixed configured repo/branch/check command, validates every path against an Astro-content whitelist, returns bounded JSON, and never exposes arbitrary shell or deployment account controls.

**Tech Stack:** TypeScript ESM, Node `fs/promises`, Node `child_process.spawn`, Zod tool schemas, existing deferred `help`/`invoke` capability system, node:test, Astro site conventions.

---

## File Structure

- Create `src/agent/tools/website.ts`
  - Owns website action schema, path policy, bounded output helpers, command runner, and `maybeCreateWebsiteTool` / `createWebsiteTool`.
  - Does not depend on `workspace_bash`.
- Create `src/agent/tools/website.test.ts`
  - Focused tests for status/read/write/publish and path safety.
- Modify `src/config/index.ts`
  - Adds optional `config.website` parsed from `BOT_WEBSITE_*`.
- Modify `src/config/index.test.ts`
  - Covers disabled/default website config and enabled env parsing.
- Modify `src/agent/tools/index.ts`
  - Registers `website` as a deferred capability only when enabled.
- Modify `src/agent/tools/merged-tools.test.ts`
  - Proves `website` is not always-on and appears only as deferred when enabled/test-injected.
- Modify `src/ops/tool-call-log.ts`
  - Marks `website` write/publish as side-effect operations.
- Modify `src/agent/tool.test.ts`
  - Covers `isSideEffectTool('website', ...)`.
- Modify `.env.example`
  - Documents the Astro site repo envs.
- Modify `docs/TOOLS.md`
  - Documents the `website` capability and security boundary.
- Modify `prompts/bot-system.md`
  - Adds a short progressive-disclosure index mention for website maintenance.
- Modify `src/agent/bot-system-prompt.test.ts`
  - Keeps prompt guidance aligned with deferred capability names.

---

### Task 1: Parse Website Configuration

**Files:**
- Modify: `src/config/index.test.ts`
- Modify: `src/config/index.ts`

- [ ] **Step 1: Write failing config tests**

Add these tests inside the existing `describe('config', () => { ... })` block in `src/config/index.test.ts`, near the browser/openbb config tests:

```ts
  test('website capability is disabled by default', () => {
    const config = parseConfig(createBaseEnv())

    assert.equal(config.website, undefined)
  })

  test('parses website capability config when enabled', () => {
    const config = parseConfig(createBaseEnv({
      BOT_WEBSITE_ENABLED: 'true',
      BOT_WEBSITE_REPO_DIR: '/Users/zzz/WebstormProjects/luna-site',
      BOT_WEBSITE_PUBLIC_URL: 'https://luna.example.com',
      BOT_WEBSITE_BRANCH: 'main',
      BOT_WEBSITE_CHECK_COMMAND: 'pnpm build',
      BOT_WEBSITE_COMMAND_TIMEOUT_MS: '45000',
    }))

    assert.deepEqual(config.website, {
      repoDir: '/Users/zzz/WebstormProjects/luna-site',
      publicUrl: 'https://luna.example.com',
      branch: 'main',
      checkCommand: 'pnpm build',
      commandTimeoutMs: 45_000,
    })
  })

  test('website config requires repo dir when enabled', () => {
    assert.throws(
      () => parseConfig(createBaseEnv({
        BOT_WEBSITE_ENABLED: 'true',
        BOT_WEBSITE_PUBLIC_URL: 'https://luna.example.com',
      })),
      /BOT_WEBSITE_REPO_DIR is required when BOT_WEBSITE_ENABLED=true/,
    )
  })
```

- [ ] **Step 2: Run config tests to verify they fail**

Run:

```bash
node --import tsx --test src/config/index.test.ts
```

Expected: FAIL because `config.website` does not exist yet.

- [ ] **Step 3: Implement config parsing**

In `src/config/index.ts`, add this type near the other config types:

```ts
type WebsiteConfig = {
  repoDir: string
  publicUrl?: string
  branch: string
  checkCommand: string
  commandTimeoutMs: number
}
```

Add this parser after `parseOwner`:

```ts
function parseWebsiteConfig(env: EnvSource): WebsiteConfig | undefined {
  if (!parseBoolean(env.BOT_WEBSITE_ENABLED, false)) return undefined

  const repoDir = env.BOT_WEBSITE_REPO_DIR?.trim() ?? ''
  if (!repoDir) {
    throw new Error('BOT_WEBSITE_REPO_DIR is required when BOT_WEBSITE_ENABLED=true')
  }

  const publicUrl = env.BOT_WEBSITE_PUBLIC_URL?.trim()
  const branch = env.BOT_WEBSITE_BRANCH?.trim() || 'main'
  const checkCommand = env.BOT_WEBSITE_CHECK_COMMAND?.trim() || 'pnpm build'
  const commandTimeoutMs = parsePositiveInteger(env.BOT_WEBSITE_COMMAND_TIMEOUT_MS, 60_000)

  return {
    repoDir,
    ...(publicUrl ? { publicUrl } : {}),
    branch,
    checkCommand,
    commandTimeoutMs,
  }
}
```

In the return object of `parseConfig`, add:

```ts
    website: parseWebsiteConfig(env),
```

Place it near `browser` / `openbb`, before `llm`.

- [ ] **Step 4: Run config tests to verify they pass**

Run:

```bash
node --import tsx --test src/config/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit config slice**

```bash
git add src/config/index.ts src/config/index.test.ts
git commit -m "feat: 增加网站能力配置"
```

---

### Task 2: Implement Website Path Policy

**Files:**
- Create: `src/agent/tools/website.ts`
- Create: `src/agent/tools/website.test.ts`

- [ ] **Step 1: Write failing path policy tests**

Create `src/agent/tools/website.test.ts`:

```ts
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  isAllowedWebsiteReadPath,
  isAllowedWebsiteWritePath,
  safeWebsiteRelativePath,
} from './website.js'

describe('website path policy', () => {
  test('allows Astro content and narrow style paths', () => {
    assert.equal(isAllowedWebsiteReadPath('src/content/posts/hello.md'), true)
    assert.equal(isAllowedWebsiteWritePath('src/content/posts/hello.md'), true)
    assert.equal(isAllowedWebsiteReadPath('src/content/notes/today.mdx'), true)
    assert.equal(isAllowedWebsiteWritePath('src/content/notes/today.mdx'), true)
    assert.equal(isAllowedWebsiteReadPath('src/content/profile.json'), true)
    assert.equal(isAllowedWebsiteWritePath('src/content/profile.json'), true)
    assert.equal(isAllowedWebsiteReadPath('src/pages/about.astro'), true)
    assert.equal(isAllowedWebsiteWritePath('src/pages/about.astro'), true)
    assert.equal(isAllowedWebsiteReadPath('src/styles/tokens.css'), true)
    assert.equal(isAllowedWebsiteWritePath('src/styles/tokens.css'), true)
    assert.equal(isAllowedWebsiteReadPath('src/styles/components.css'), true)
    assert.equal(isAllowedWebsiteWritePath('src/styles/components.css'), true)
    assert.equal(isAllowedWebsiteReadPath('public/images/avatar.webp'), true)
    assert.equal(isAllowedWebsiteWritePath('public/images/avatar.webp'), true)
  })

  test('rejects config, ci, hidden files, scripts, and path escape', () => {
    const rejected = [
      '../secret.md',
      '/tmp/file.md',
      '.env',
      'src/content/.draft.md',
      '.github/workflows/deploy.yml',
      '.vercel/project.json',
      'package.json',
      'pnpm-lock.yaml',
      'astro.config.mjs',
      'tsconfig.json',
      'src/pages/index.astro',
      'src/styles/global.css',
      'scripts/build.js',
      'public/images/evil.js',
    ]

    for (const file of rejected) {
      assert.equal(isAllowedWebsiteReadPath(file), false, file)
      assert.equal(isAllowedWebsiteWritePath(file), false, file)
    }
  })

  test('normalizes safe relative paths', () => {
    assert.equal(safeWebsiteRelativePath('src/content/posts/hello.md'), 'src/content/posts/hello.md')
    assert.equal(safeWebsiteRelativePath('src/content/posts//hello.md'), 'src/content/posts/hello.md')
    assert.equal(safeWebsiteRelativePath('src\\content\\posts\\hello.md'), null)
    assert.equal(safeWebsiteRelativePath('../hello.md'), null)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --import tsx --test src/agent/tools/website.test.ts
```

Expected: FAIL because `src/agent/tools/website.ts` does not exist.

- [ ] **Step 3: Implement path policy**

Create `src/agent/tools/website.ts` with this initial content:

```ts
import { normalize } from 'node:path'

const TEXT_WRITE_EXTENSIONS = new Set(['.md', '.mdx', '.json', '.txt', '.css', '.astro'])
const IMAGE_WRITE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg'])

export function safeWebsiteRelativePath(file: string): string | null {
  const trimmed = file.trim()
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\\')) return null

  const normalized = normalize(trimmed).split('\\').join('/')
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.split('/').some((segment) => segment === '..' || segment.startsWith('.'))
  ) {
    return null
  }

  return normalized
}

export function isAllowedWebsiteReadPath(file: string): boolean {
  const normalized = safeWebsiteRelativePath(file)
  if (!normalized) return false
  return isAllowedWebsiteContentPath(normalized)
}

export function isAllowedWebsiteWritePath(file: string): boolean {
  const normalized = safeWebsiteRelativePath(file)
  if (!normalized) return false
  if (!isAllowedWebsiteContentPath(normalized)) return false
  const ext = extensionOf(normalized)
  return TEXT_WRITE_EXTENSIONS.has(ext) || IMAGE_WRITE_EXTENSIONS.has(ext)
}

function isAllowedWebsiteContentPath(file: string): boolean {
  if (file.startsWith('src/content/')) return true
  if (file === 'src/pages/about.astro') return true
  if (file === 'src/styles/tokens.css') return true
  if (file === 'src/styles/components.css') return true
  if (file.startsWith('public/images/')) return true
  return false
}

function extensionOf(file: string): string {
  const index = file.lastIndexOf('.')
  return index >= 0 ? file.slice(index).toLowerCase() : ''
}
```

- [ ] **Step 4: Run path policy tests**

Run:

```bash
node --import tsx --test src/agent/tools/website.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit path policy slice**

```bash
git add src/agent/tools/website.ts src/agent/tools/website.test.ts
git commit -m "feat: 增加网站路径安全策略"
```

---

### Task 3: Add Website Status, Read, and Write Actions

**Files:**
- Modify: `src/agent/tools/website.ts`
- Modify: `src/agent/tools/website.test.ts`

- [ ] **Step 1: Add failing tool behavior tests**

Append these imports to `src/agent/tools/website.test.ts`:

```ts
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import { createWebsiteTool, type WebsiteCommandRunner } from './website.js'
```

Append these helpers:

```ts
function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
}

async function makeSiteRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'luna-site-'))
  await mkdir(join(dir, 'src/content/posts'), { recursive: true })
  await mkdir(join(dir, 'src/styles'), { recursive: true })
  await writeFile(join(dir, 'src/content/posts/hello.md'), '# hello\n', 'utf8')
  await writeFile(join(dir, 'src/styles/tokens.css'), ':root { --color-bg: #fff; }\n', 'utf8')
  return dir
}

function makeRunner(outputs: Record<string, { exitCode?: number | null; stdout?: string; stderr?: string }> = {}): WebsiteCommandRunner {
  return async (command) => {
    const key = [command.executable, ...command.args].join(' ')
    const output = outputs[key] ?? { stdout: '' }
    return {
      exitCode: output.exitCode ?? 0,
      stdout: output.stdout ?? '',
      stderr: output.stderr ?? '',
      timedOut: false,
    }
  }
}
```

Append these tests:

```ts
describe('website tool read/write/status', () => {
  test('reads allowed files with truncation metadata', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'read',
        file: 'src/content/posts/hello.md',
        maxChars: 20,
      }, makeCtx())).content as string) as { ok: boolean; file: string; content: string; truncated: boolean }

      assert.equal(result.ok, true)
      assert.equal(result.file, 'src/content/posts/hello.md')
      assert.equal(result.content, '# hello\n')
      assert.equal(result.truncated, false)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('rejects reading disallowed files', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'read',
        file: 'package.json',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'path_not_allowed')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('writes allowed text files', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'write',
        file: 'src/content/posts/new.md',
        content: '# new\n',
      }, makeCtx())).content as string) as { ok: boolean; file: string; bytes: number }

      assert.equal(result.ok, true)
      assert.equal(result.file, 'src/content/posts/new.md')
      assert.equal(await readFile(join(repoDir, 'src/content/posts/new.md'), 'utf8'), '# new\n')
      assert.equal(result.bytes, Buffer.byteLength('# new\n'))
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('status returns bounded git state', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const runner = makeRunner({
        'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
        'git remote get-url origin': { stdout: 'git@github.com:owner/luna-site.git\n' },
        'git rev-parse --short HEAD': { stdout: 'abc1234\n' },
        'git status --porcelain': { stdout: ' M src/content/posts/hello.md\n' },
      })
      const tool = createWebsiteTool({
        repoDir,
        publicUrl: 'https://luna.example.com',
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner,
      })

      const result = JSON.parse((await tool.execute({ action: 'status' }, makeCtx())).content as string) as {
        ok: boolean
        repoDir: string
        publicUrl: string
        branch: string
        remote: string
        latestCommit: string
        dirty: boolean
        changedFiles: string[]
      }

      assert.equal(result.ok, true)
      assert.equal(result.repoDir, repoDir)
      assert.equal(result.publicUrl, 'https://luna.example.com')
      assert.equal(result.branch, 'main')
      assert.equal(result.remote, 'git@github.com:owner/luna-site.git')
      assert.equal(result.latestCommit, 'abc1234')
      assert.equal(result.dirty, true)
      assert.deepEqual(result.changedFiles, ['src/content/posts/hello.md'])
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --import tsx --test src/agent/tools/website.test.ts
```

Expected: FAIL because the tool constructors and actions are missing.

- [ ] **Step 3: Implement tool schema and actions**

Replace `src/agent/tools/website.ts` with a full implementation that keeps the path helpers from Task 2 and adds:

```ts
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../tool.js'
import { config } from '../../config/index.js'
```

Add these constants and types:

```ts
const DEFAULT_READ_MAX_CHARS = 12_000
const READ_MAX_CHARS_CAP = 50_000
const WRITE_MAX_BYTES = 256 * 1024
const COMMAND_OUTPUT_CAP = 4_000

export interface WebsiteCommandRunInput {
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
}

export interface WebsiteCommandRunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type WebsiteCommandRunner = (input: WebsiteCommandRunInput) => Promise<WebsiteCommandRunResult>

export interface WebsiteToolDeps {
  repoDir?: string
  publicUrl?: string
  branch?: string
  checkCommand?: string
  commandTimeoutMs?: number
  runner?: WebsiteCommandRunner
}
```

Add the Zod schema:

```ts
const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('status'),
  }),
  z.object({
    action: z.literal('read'),
    file: z.string().trim().min(1).max(240),
    maxChars: z.number().int().min(100).max(READ_MAX_CHARS_CAP).optional(),
  }),
  z.object({
    action: z.literal('write'),
    file: z.string().trim().min(1).max(240),
    content: z.string().max(WRITE_MAX_BYTES),
    encoding: z.enum(['utf8', 'base64']).optional(),
  }),
  z.object({
    action: z.literal('publish'),
    message: z.string().trim().min(1).max(120).optional(),
  }),
])

type Args = z.infer<typeof argsSchema>
```

Add constructors:

```ts
export function maybeCreateWebsiteTool(deps: WebsiteToolDeps = {}): Tool<Args> | null {
  const websiteConfig = config.website
  const repoDir = deps.repoDir ?? websiteConfig?.repoDir
  if (!repoDir) return null

  return createWebsiteTool({
    repoDir,
    publicUrl: deps.publicUrl ?? websiteConfig?.publicUrl,
    branch: deps.branch ?? websiteConfig?.branch ?? 'main',
    checkCommand: deps.checkCommand ?? websiteConfig?.checkCommand ?? 'pnpm build',
    commandTimeoutMs: deps.commandTimeoutMs ?? websiteConfig?.commandTimeoutMs ?? 60_000,
    runner: deps.runner,
  })
}

export function createWebsiteTool(deps: Required<Pick<WebsiteToolDeps, 'repoDir' | 'branch' | 'checkCommand' | 'commandTimeoutMs'>> & WebsiteToolDeps): Tool<Args> {
  const repoDir = resolve(deps.repoDir)
  const runner = deps.runner ?? runWebsiteCommand

  return {
    name: 'website',
    description: [
      'Luna 个人网站维护工具. 只操作 owner 已配置的 Astro 网站仓库.',
      'action=status/read/write/publish.',
      '只能读写 src/content/**、src/pages/about.astro、src/styles/tokens.css、src/styles/components.css、public/images/**.',
      'publish 会固定执行配置的检查命令, 只提交白名单文件, 然后 push 到配置分支.',
      '不能改 Vercel、GitHub Actions、依赖、构建配置、secret 或任意 shell.',
    ].join(' '),
    schema: argsSchema,
    async execute(args) {
      if (args.action === 'status') {
        return { content: JSON.stringify(await getWebsiteStatus({ repoDir, publicUrl: deps.publicUrl, branch: deps.branch, runner, timeoutMs: deps.commandTimeoutMs })) }
      }
      if (args.action === 'read') {
        return { content: JSON.stringify(await readWebsiteFile({ repoDir, file: args.file, maxChars: args.maxChars })) }
      }
      if (args.action === 'write') {
        return { content: JSON.stringify(await writeWebsiteFile({ repoDir, file: args.file, content: args.content, encoding: args.encoding })) }
      }
      return { content: JSON.stringify(await publishWebsite({ repoDir, branch: deps.branch, checkCommand: deps.checkCommand, message: args.message, runner, timeoutMs: deps.commandTimeoutMs })) }
    },
  }
}
```

Add helper functions:

```ts
function sitePath(repoDir: string, file: string): string | null {
  const relative = safeWebsiteRelativePath(file)
  if (!relative) return null
  const absolute = resolve(repoDir, relative)
  if (absolute !== repoDir && !absolute.startsWith(`${repoDir}/`)) return null
  return absolute
}

async function readWebsiteFile(input: { repoDir: string; file: string; maxChars?: number }) {
  if (!isAllowedWebsiteReadPath(input.file)) {
    return { ok: false, code: 'path_not_allowed', error: 'file is outside allowed website paths' }
  }
  const absolute = sitePath(input.repoDir, input.file)
  if (!absolute) return { ok: false, code: 'path_not_allowed', error: 'invalid file path' }
  const raw = await readFile(absolute, 'utf8')
  const maxChars = input.maxChars ?? DEFAULT_READ_MAX_CHARS
  return {
    ok: true,
    file: safeWebsiteRelativePath(input.file),
    content: raw.length > maxChars ? raw.slice(0, maxChars) : raw,
    truncated: raw.length > maxChars,
  }
}

async function writeWebsiteFile(input: { repoDir: string; file: string; content: string; encoding?: 'utf8' | 'base64' }) {
  if (!isAllowedWebsiteWritePath(input.file)) {
    return { ok: false, code: 'path_not_allowed', error: 'file is outside allowed website write paths' }
  }
  const absolute = sitePath(input.repoDir, input.file)
  if (!absolute) return { ok: false, code: 'path_not_allowed', error: 'invalid file path' }
  const bytes = input.encoding === 'base64'
    ? Buffer.from(input.content, 'base64')
    : Buffer.from(input.content, 'utf8')
  if (bytes.length > WRITE_MAX_BYTES) {
    return { ok: false, code: 'file_too_large', error: `file exceeds ${WRITE_MAX_BYTES} bytes` }
  }
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, bytes)
  return { ok: true, file: safeWebsiteRelativePath(input.file), bytes: bytes.length }
}

async function getWebsiteStatus(input: { repoDir: string; publicUrl?: string; branch: string; runner: WebsiteCommandRunner; timeoutMs: number }) {
  const [branch, remote, latestCommit, status] = await Promise.all([
    runGit(input.runner, input.repoDir, input.timeoutMs, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(input.runner, input.repoDir, input.timeoutMs, ['remote', 'get-url', 'origin']),
    runGit(input.runner, input.repoDir, input.timeoutMs, ['rev-parse', '--short', 'HEAD']),
    runGit(input.runner, input.repoDir, input.timeoutMs, ['status', '--porcelain']),
  ])
  const changedFiles = parsePorcelainFiles(status.stdout).slice(0, 50)
  return {
    ok: branch.exitCode === 0 && status.exitCode === 0,
    repoDir: input.repoDir,
    ...(input.publicUrl ? { publicUrl: input.publicUrl } : {}),
    branch: branch.stdout.trim(),
    expectedBranch: input.branch,
    remote: remote.stdout.trim(),
    latestCommit: latestCommit.stdout.trim(),
    dirty: changedFiles.length > 0,
    changedFiles,
  }
}

function parsePorcelainFiles(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => file.includes(' -> ') ? file.split(' -> ').at(-1)! : file)
}

async function runGit(runner: WebsiteCommandRunner, cwd: string, timeoutMs: number, args: string[]): Promise<WebsiteCommandRunResult> {
  return await runner({ executable: 'git', args, cwd, timeoutMs })
}
```

Add default runner and clipping:

```ts
export async function runWebsiteCommand(input: WebsiteCommandRunInput): Promise<WebsiteCommandRunResult> {
  return await new Promise((resolveRun) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: minimalEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, input.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout = clip(stdout + chunk, COMMAND_OUTPUT_CAP) })
    child.stderr.on('data', (chunk) => { stderr = clip(stderr + chunk, COMMAND_OUTPUT_CAP) })
    child.on('close', (exitCode) => {
      clearTimeout(timer)
      resolveRun({ exitCode, stdout, stderr, timedOut })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveRun({ exitCode: null, stdout, stderr: error.message, timedOut })
    })
  })
}

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG ?? 'C.UTF-8',
  }
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return value.slice(value.length - maxChars)
}
```

Keep the path policy functions from Task 2 at the bottom of the file.

- [ ] **Step 4: Run tests**

Run:

```bash
node --import tsx --test src/agent/tools/website.test.ts
```

Expected: PASS for path, read, write, and status tests. `publish` is still untested/unimplemented and is allowed to fail if called.

- [ ] **Step 5: Commit read/write/status slice**

```bash
git add src/agent/tools/website.ts src/agent/tools/website.test.ts
git commit -m "feat: 增加网站内容读写工具"
```

---

### Task 4: Add Publish Flow

**Files:**
- Modify: `src/agent/tools/website.ts`
- Modify: `src/agent/tools/website.test.ts`

- [ ] **Step 1: Add failing publish tests**

Append these tests to `describe('website tool read/write/status', ...)`:

```ts
  test('publish rejects wrong branch', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const runner = makeRunner({
        'git rev-parse --abbrev-ref HEAD': { stdout: 'draft\n' },
      })
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner,
      })

      const result = JSON.parse((await tool.execute({ action: 'publish' }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'wrong_branch')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish rejects dirty worktree with non-whitelisted changes', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const runner = makeRunner({
        'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
        'git status --porcelain': { stdout: ' M package.json\n M src/content/posts/hello.md\n' },
      })
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner,
      })

      const result = JSON.parse((await tool.execute({ action: 'publish' }, makeCtx())).content as string) as {
        ok: boolean
        code: string
        unsafeFiles: string[]
      }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'unsafe_dirty_worktree')
      assert.deepEqual(result.unsafeFiles, ['package.json'])
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish runs check, commits, and pushes allowed changes', async () => {
    const repoDir = await makeSiteRepo()
    const commands: string[] = []
    try {
      const runner: WebsiteCommandRunner = async (command) => {
        commands.push([command.executable, ...command.args].join(' '))
        const key = commands.at(-1)!
        if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }
        if (key === 'git status --porcelain') return { exitCode: 0, stdout: ' M src/content/posts/hello.md\n', stderr: '', timedOut: false }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        if (key === 'git add src/content/posts/hello.md') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (key.startsWith('git commit -m ')) return { exitCode: 0, stdout: '[main abc1234] content\n', stderr: '', timedOut: false }
        if (key === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: 'abc1234\n', stderr: '', timedOut: false }
        if (key === 'git push origin main') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        return { exitCode: 1, stdout: '', stderr: `unexpected command ${key}`, timedOut: false }
      }
      const tool = createWebsiteTool({
        repoDir,
        publicUrl: 'https://luna.example.com',
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner,
      })

      const result = JSON.parse((await tool.execute({
        action: 'publish',
        message: 'content: 更新 hello',
      }, makeCtx())).content as string) as {
        ok: boolean
        commit: string
        changedFiles: string[]
        publicUrl: string
      }

      assert.equal(result.ok, true)
      assert.equal(result.commit, 'abc1234')
      assert.deepEqual(result.changedFiles, ['src/content/posts/hello.md'])
      assert.equal(result.publicUrl, 'https://luna.example.com')
      assert.deepEqual(commands, [
        'git rev-parse --abbrev-ref HEAD',
        'git status --porcelain',
        'pnpm build',
        'git add src/content/posts/hello.md',
        'git commit -m content: 更新 hello',
        'git rev-parse --short HEAD',
        'git push origin main',
      ])
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: Run publish tests to verify they fail**

Run:

```bash
node --import tsx --test src/agent/tools/website.test.ts
```

Expected: FAIL because `publishWebsite` is not implemented.

- [ ] **Step 3: Implement publish**

In `src/agent/tools/website.ts`, add:

```ts
async function publishWebsite(input: {
  repoDir: string
  branch: string
  checkCommand: string
  message?: string
  runner: WebsiteCommandRunner
  timeoutMs: number
}) {
  const branch = await runGit(input.runner, input.repoDir, input.timeoutMs, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const currentBranch = branch.stdout.trim()
  if (branch.exitCode !== 0) {
    return failedCommand('branch_failed', 'failed to read current branch', branch)
  }
  if (currentBranch !== input.branch) {
    return { ok: false, code: 'wrong_branch', error: `current branch ${currentBranch} does not match configured branch ${input.branch}` }
  }

  const status = await runGit(input.runner, input.repoDir, input.timeoutMs, ['status', '--porcelain'])
  if (status.exitCode !== 0) {
    return failedCommand('status_failed', 'failed to read git status', status)
  }

  const changedFiles = parsePorcelainFiles(status.stdout)
  if (changedFiles.length === 0) {
    return { ok: false, code: 'nothing_to_publish', error: 'no website changes to publish' }
  }

  const unsafeFiles = changedFiles.filter((file) => !isAllowedWebsiteWritePath(file))
  if (unsafeFiles.length > 0) {
    return {
      ok: false,
      code: 'unsafe_dirty_worktree',
      error: 'worktree contains non-whitelisted website changes',
      unsafeFiles,
      changedFiles,
    }
  }

  const check = await runConfiguredCheck(input.runner, input.repoDir, input.timeoutMs, input.checkCommand)
  if (check.exitCode !== 0 || check.timedOut) {
    return failedCommand('check_failed', 'website check command failed', check)
  }

  const add = await runGit(input.runner, input.repoDir, input.timeoutMs, ['add', ...changedFiles])
  if (add.exitCode !== 0) {
    return failedCommand('git_add_failed', 'git add failed', add)
  }

  const commitMessage = input.message ?? 'content: Luna 更新个人网站'
  const commit = await runGit(input.runner, input.repoDir, input.timeoutMs, ['commit', '-m', commitMessage])
  if (commit.exitCode !== 0) {
    return failedCommand('commit_failed', 'git commit failed', commit)
  }

  const commitHash = await runGit(input.runner, input.repoDir, input.timeoutMs, ['rev-parse', '--short', 'HEAD'])
  if (commitHash.exitCode !== 0) {
    return failedCommand('commit_hash_failed', 'failed to read commit hash', commitHash)
  }

  const push = await runGit(input.runner, input.repoDir, input.timeoutMs, ['push', 'origin', input.branch])
  if (push.exitCode !== 0) {
    return failedCommand('push_failed', 'git push failed', push)
  }

  return {
    ok: true,
    branch: input.branch,
    commit: commitHash.stdout.trim(),
    changedFiles,
    check: {
      ok: true,
      stdout: clip(check.stdout, 1000),
      stderr: clip(check.stderr, 1000),
    },
    next: 'Vercel Git integration should deploy this commit from the configured branch.',
  }
}

async function runConfiguredCheck(
  runner: WebsiteCommandRunner,
  cwd: string,
  timeoutMs: number,
  command: string,
): Promise<WebsiteCommandRunResult> {
  const tokens = command.trim().split(/\s+/)
  const [executable, ...args] = tokens
  if (!executable) {
    return { exitCode: null, stdout: '', stderr: 'empty check command', timedOut: false }
  }
  return await runner({ executable, args, cwd, timeoutMs })
}

function failedCommand(code: string, error: string, result: WebsiteCommandRunResult) {
  return {
    ok: false,
    code,
    error,
    exitCode: result.exitCode,
    stdout: clip(result.stdout, 1000),
    stderr: clip(result.stderr, 1000),
    timedOut: result.timedOut,
  }
}
```

Add `publicUrl` to successful publish result by passing it through `publishWebsite`:

```ts
return { content: JSON.stringify(await publishWebsite({ repoDir, publicUrl: deps.publicUrl, branch: deps.branch, checkCommand: deps.checkCommand, message: args.message, runner, timeoutMs: deps.commandTimeoutMs })) }
```

Update `publishWebsite` input type and final return:

```ts
  publicUrl?: string
```

```ts
    ...(input.publicUrl ? { publicUrl: input.publicUrl } : {}),
```

- [ ] **Step 4: Run website tests**

Run:

```bash
node --import tsx --test src/agent/tools/website.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit publish slice**

```bash
git add src/agent/tools/website.ts src/agent/tools/website.test.ts
git commit -m "feat: 支持发布 Luna 个人网站"
```

---

### Task 5: Register Deferred Capability and Audit Side Effects

**Files:**
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agent/tools/merged-tools.test.ts`
- Modify: `src/ops/tool-call-log.ts`
- Modify: `src/agent/tool.test.ts`

- [ ] **Step 1: Add failing registration test**

In `src/agent/tools/merged-tools.test.ts`, update the first test to assert the top-level tool is not visible:

```ts
    assert.equal(names.includes('website'), false)
```

In the manifest test, add:

```ts
    if (capabilities.has('website')) assert.deepEqual(capabilities.get('website'), ['website'])
```

Then add a focused manifest test using dependency injection. First import `createWebsiteTool`:

```ts
import { createWebsiteTool } from './website.js'
```

Add this test inside `describe('merged main-agent tools', ...)`:

```ts
  test('can expose website as a deferred capability when configured', () => {
    const website = createWebsiteTool({
      repoDir: '/tmp/luna-site',
      branch: 'main',
      checkCommand: 'pnpm build',
      commandTimeoutMs: 60_000,
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    })
    const manifest = buildBotToolManifest({
      sender: mockSender,
      targetPolicy,
      selfNumber: 999,
      taskRegistry: createInMemoryTaskRegistry(),
      groupIds: [],
      metadata: { groupNames: new Map() },
      groupCustomizations: [],
      websiteTool: website,
    })
    const capabilities = new Map(manifest.capabilities.map((capability) => [
      capability.name,
      capability.tools.map((tool) => tool.name),
    ]))

    assert.deepEqual(capabilities.get('website'), ['website'])
    assert.equal(manifest.alwaysOnTools.some((tool) => tool.name === 'website'), false)
  })
```

- [ ] **Step 2: Run merged-tools test to verify it fails**

Run:

```bash
node --import tsx --test src/agent/tools/merged-tools.test.ts
```

Expected: FAIL because `BotToolDeps` has no `websiteTool` and `website` is not registered.

- [ ] **Step 3: Register website capability**

In `src/agent/tools/index.ts`, import:

```ts
import { maybeCreateWebsiteTool } from './website.js'
```

Extend `BotToolDeps`:

```ts
  websiteTool?: Tool
```

After browser/openbb registration and before `external_research`, add:

```ts
  const website = deps.websiteTool ?? maybeCreateWebsiteTool()
  if (website) {
    capabilities.push({
      name: 'website',
      description: 'Luna 个人网站维护: 读取/写入 Astro 内容文件, 构建检查, commit 并 push 到配置分支.',
      tools: [website],
    })
  }
```

- [ ] **Step 4: Add failing side-effect tests**

In `src/agent/tool.test.ts`, find the side-effect classification test and add:

```ts
    await exec.execute({ id: 'website-status', name: 'website', args: { action: 'status' } }, makeCtx())
    await exec.execute({ id: 'website-read', name: 'website', args: { action: 'read', file: 'src/content/posts/a.md' } }, makeCtx())
    await exec.execute({ id: 'website-write', name: 'website', args: { action: 'write', file: 'src/content/posts/a.md', content: 'hi' } }, makeCtx())
    await exec.execute({ id: 'website-publish', name: 'website', args: { action: 'publish' } }, makeCtx())
```

Update the assertions for side-effect flags to expect:

```ts
    assert.equal(entries.find((entry) => entry.toolCallId === 'website-status')?.sideEffect, false)
    assert.equal(entries.find((entry) => entry.toolCallId === 'website-read')?.sideEffect, false)
    assert.equal(entries.find((entry) => entry.toolCallId === 'website-write')?.sideEffect, true)
    assert.equal(entries.find((entry) => entry.toolCallId === 'website-publish')?.sideEffect, true)
```

If the existing test uses a local `Tool` stub list, add this stub:

```ts
    const website: Tool<Record<string, unknown>> = {
      name: 'website',
      description: 'website',
      schema: z.object({ action: z.string() }).passthrough(),
      async execute() {
        return { content: 'ok' }
      },
    }
```

and include it in `createToolExecutor([...])`.

- [ ] **Step 5: Implement side-effect classification**

In `src/ops/tool-call-log.ts`, add before `workspace_bash`:

```ts
  if (toolName === 'website') {
    return hasAnyAction(args, ['write', 'publish'])
  }
```

- [ ] **Step 6: Run registration and audit tests**

Run:

```bash
node --import tsx --test src/agent/tools/merged-tools.test.ts src/agent/tool.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit registration slice**

```bash
git add src/agent/tools/index.ts src/agent/tools/merged-tools.test.ts src/ops/tool-call-log.ts src/agent/tool.test.ts
git commit -m "feat: 注册网站维护能力"
```

---

### Task 6: Update Prompt and Documentation

**Files:**
- Modify: `.env.example`
- Modify: `docs/TOOLS.md`
- Modify: `prompts/bot-system.md`
- Modify: `src/agent/bot-system-prompt.test.ts`

- [ ] **Step 1: Add failing prompt test**

In `src/agent/bot-system-prompt.test.ts`, inside `keeps progressive-disclosure guidance aligned with the visible tool surface`, add:

```ts
    assert.match(helpLine, /网站维护/)
    assert.match(invokeLine, /website/)
```

- [ ] **Step 2: Run prompt test to verify it fails**

Run:

```bash
node --import tsx --test src/agent/bot-system-prompt.test.ts
```

Expected: FAIL because prompt does not mention website yet.

- [ ] **Step 3: Update prompt**

In `prompts/bot-system.md`, replace the help/invoke bullets with:

```md
- help: 需要浏览器、金融数据、外部研究、图片生成、图片抓取或个人网站维护时, 先 action=list/describe 查看 capability 和内部工具 schema, 再 action=activate 激活对应 capability; 顶层工具面不会因为激活而变化.
- invoke: 调用已激活 capability 内部工具时使用, 例如 tool=browser / website / web_search / fetch_content / generate_image / openbb_cli, args 按 help describe 返回的 schema 填.
```

- [ ] **Step 4: Update `.env.example`**

Add this block after the browser capability block:

```env
# ── Luna 个人网站维护能力 (可选) ─────────────────────────────────────────────
# 启用后注册 deferred website capability. 该能力只维护 owner 已创建并首发过的
# Astro 网站仓库；域名、Vercel 项目、GitHub/Vercel secrets 仍由 owner 配置。
# BOT_WEBSITE_ENABLED=true
# BOT_WEBSITE_REPO_DIR=/Users/zzz/WebstormProjects/luna-site
# BOT_WEBSITE_PUBLIC_URL=https://luna.example.com
# BOT_WEBSITE_BRANCH=main
# BOT_WEBSITE_CHECK_COMMAND=pnpm build
# BOT_WEBSITE_COMMAND_TIMEOUT_MS=60000
```

- [ ] **Step 5: Update `docs/TOOLS.md`**

In Deferred capability list, add:

```md
- `website`：配置 `BOT_WEBSITE_ENABLED=true` 后可激活，内部工具是单一 action-driven `website`，用于维护 owner 已配置好的 Luna Astro 个人网站仓库。
```

In security rules, add:

```md
- `website` 只允许读写配置网站仓库里的 Astro 内容白名单路径；`publish` 固定执行配置的检查命令，只提交白名单文件并 push 到配置分支。它不能改 Vercel/GitHub Actions/依赖/构建配置/secret，也不暴露任意 shell。
```

In modification checklist, add `website` to the tool behavior docs if needed:

```md
- 如果能力面变化，同步更新本文档、`.env.example` 和 prompt 的按需披露索引。
```

- [ ] **Step 6: Run docs/prompt checks**

Run:

```bash
node --import tsx --test src/agent/bot-system-prompt.test.ts
pnpm repo-check
```

Expected: PASS.

- [ ] **Step 7: Commit docs slice**

```bash
git add .env.example docs/TOOLS.md prompts/bot-system.md src/agent/bot-system-prompt.test.ts
git commit -m "docs: 说明 Luna 网站维护能力"
```

---

### Task 7: Final Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --import tsx --test src/config/index.test.ts src/agent/tools/website.test.ts src/agent/tools/merged-tools.test.ts src/agent/tool.test.ts src/agent/bot-system-prompt.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repo checks**

Run:

```bash
pnpm repo-check
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
```

Expected:

- Only planned files are changed in the feature commits.
- No files under `data/agent-workspace/` are staged.
- Existing unrelated user changes are not reverted.

- [ ] **Step 4: Manual dry-run with a temporary Astro-like repo**

Create a throwaway repo and run only the `website` tool tests against the real runner if desired:

```bash
tmpdir="$(mktemp -d)"
mkdir -p "$tmpdir/src/content/posts" "$tmpdir/src/styles"
printf '{"scripts":{"build":"astro --version >/dev/null 2>&1 || true"}}\n' > "$tmpdir/package.json"
printf '# hello\n' > "$tmpdir/src/content/posts/hello.md"
printf ':root { --color-bg: #fff; }\n' > "$tmpdir/src/styles/tokens.css"
git -C "$tmpdir" init
git -C "$tmpdir" add .
git -C "$tmpdir" commit -m init
```

Expected: This confirms the command runner shape. Do not push from this dry-run.

- [ ] **Step 5: Final commit if any verification-only fixes were needed**

If Step 1 or Step 2 required small fixes, commit them:

```bash
git add <fixed-files>
git commit -m "fix: 完善网站维护能力验证"
```

If no fixes were needed, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage:
  - Independent repo: covered by config `BOT_WEBSITE_REPO_DIR` and docs.
  - Astro content whitelist: covered by `website.ts` path policy.
  - Status/read/write/publish: covered by tool actions and tests.
  - Push to configured branch: covered by publish flow.
  - No Vercel/DNS/repo creation: covered by docs and absence of actions.
  - No Codex CLI in MVP: covered by non-goal and no implementation tasks.
  - AgentContext hygiene: covered by bounded JSON, clipped command output, no file/log replay.
- Placeholder scan: no `TBD`, no "implement later", no "add appropriate".
- Type consistency:
  - Tool action names are `status`, `read`, `write`, `publish`.
  - Config object is `config.website`.
  - Deferred capability name and tool name are both `website`.
