import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import { createWebsiteTool, type WebsiteCommandRunner } from './website.js'
import {
  isAllowedWebsiteReadPath,
  isAllowedWebsiteWritePath,
  safeWebsiteRelativePath,
} from './website.js'

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

function makeRunner(
  outputs: Record<string, { exitCode?: number | null; stdout?: string; stderr?: string }> = {},
): WebsiteCommandRunner {
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

const WRITE_MAX_BYTES_FOR_TEST = 256 * 1024
const READ_MAX_BYTES_FOR_TEST = 256 * 1024

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

  test('rejects text files under public images', () => {
    const rejected = [
      'public/images/readme.md',
      'public/images/style.css',
      'public/images/data.json',
    ]

    for (const file of rejected) {
      assert.equal(isAllowedWebsiteReadPath(file), false, file)
      assert.equal(isAllowedWebsiteWritePath(file), false, file)
    }
  })

  test('rejects non-content extensions under Astro content', () => {
    const rejected = [
      'src/content/posts/photo.png',
      'src/content/posts/style.css',
      'src/content/posts/page.astro',
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

  test('rejects raw parent and hidden path segments before normalization', () => {
    const rejected = [
      'src/content/../content/posts/hello.md',
      'src/content/.hidden/../posts/hello.md',
    ]

    for (const file of rejected) {
      assert.equal(safeWebsiteRelativePath(file), null, file)
      assert.equal(isAllowedWebsiteReadPath(file), false, file)
      assert.equal(isAllowedWebsiteWritePath(file), false, file)
    }
  })
})

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

  test('returns file_not_found for missing allowed reads', async () => {
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
        file: 'src/content/posts/missing.md',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'file_not_found')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('rejects binary image reads while keeping image writes allowed', async () => {
    const repoDir = await makeSiteRepo()
    try {
      await mkdir(join(repoDir, 'public/images'), { recursive: true })
      await writeFile(join(repoDir, 'public/images/avatar.webp'), Buffer.from([0, 1, 2, 3]))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'read',
        file: 'public/images/avatar.webp',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'binary_read_not_supported')
      assert.equal(isAllowedWebsiteWritePath('public/images/avatar.webp'), true)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('rejects oversized text reads before returning content', async () => {
    const repoDir = await makeSiteRepo()
    try {
      await writeFile(join(repoDir, 'src/content/posts/large.md'), `${'a'.repeat(READ_MAX_BYTES_FOR_TEST + 1)}\n`, 'utf8')
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'read',
        file: 'src/content/posts/large.md',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'file_too_large')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('rejects directory reads at allowed paths', async () => {
    const repoDir = await makeSiteRepo()
    try {
      await mkdir(join(repoDir, 'src/content/posts/dir.md'))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'read',
        file: 'src/content/posts/dir.md',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'not_regular_file')
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

  test('rejects writes to existing directories at allowed paths', async () => {
    const repoDir = await makeSiteRepo()
    try {
      await mkdir(join(repoDir, 'src/content/posts/dir.md'))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'write',
        file: 'src/content/posts/dir.md',
        content: '# changed\n',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'not_regular_file')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('accepts max-size base64 payloads at schema layer', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const parsed = tool.schema.safeParse({
        action: 'write',
        file: 'public/images/avatar.webp',
        content: Buffer.alloc(WRITE_MAX_BYTES_FOR_TEST).toString('base64'),
        encoding: 'base64',
      })

      assert.equal(parsed.success, true)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('rejects decoded oversized base64 writes', async () => {
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
        file: 'public/images/avatar.webp',
        content: Buffer.alloc(WRITE_MAX_BYTES_FOR_TEST + 1).toString('base64'),
        encoding: 'base64',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'file_too_large')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('rejects reading allowed-path symlinks that point outside repo', async () => {
    const repoDir = await makeSiteRepo()
    const outsideDir = await mkdtemp(join(tmpdir(), 'luna-site-outside-'))
    try {
      const outsideFile = join(outsideDir, 'secret.md')
      await writeFile(outsideFile, '# outside\n', 'utf8')
      await symlink(outsideFile, join(repoDir, 'src/content/posts/link.md'))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'read',
        file: 'src/content/posts/link.md',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'path_not_allowed')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('rejects writing allowed-path symlinks that point outside repo', async () => {
    const repoDir = await makeSiteRepo()
    const outsideDir = await mkdtemp(join(tmpdir(), 'luna-site-outside-'))
    try {
      const outsideFile = join(outsideDir, 'secret.md')
      await writeFile(outsideFile, '# outside\n', 'utf8')
      await symlink(outsideFile, join(repoDir, 'src/content/posts/link.md'))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'write',
        file: 'src/content/posts/link.md',
        content: '# changed\n',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'path_not_allowed')
      assert.equal(await readFile(outsideFile, 'utf8'), '# outside\n')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('rejects writing through intermediate symlink directories without outside side effects', async () => {
    const repoDir = await makeSiteRepo()
    const outsideDir = await mkdtemp(join(tmpdir(), 'luna-site-outside-'))
    try {
      await symlink(outsideDir, join(repoDir, 'src/content/posts/linkdir'))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'write',
        file: 'src/content/posts/linkdir/sub/new.md',
        content: '# changed\n',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'path_not_allowed')
      await assert.rejects(stat(join(outsideDir, 'sub')), { code: 'ENOENT' })
      await assert.rejects(stat(join(outsideDir, 'sub/new.md')), { code: 'ENOENT' })
    } finally {
      await rm(repoDir, { recursive: true, force: true })
      await rm(outsideDir, { recursive: true, force: true })
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

  test('status reports failure when essential git commands fail', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const runner = makeRunner({
        'git rev-parse --abbrev-ref HEAD': { exitCode: 128, stderr: 'fatal: not a git repository\n' },
        'git remote get-url origin': { exitCode: 128, stderr: 'fatal: no remote\n' },
        'git rev-parse --short HEAD': { exitCode: 128, stderr: 'fatal: no commit\n' },
        'git status --porcelain': { exitCode: 128, stderr: 'fatal: not a git repository\n' },
      })
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner,
      })

      const result = JSON.parse((await tool.execute({ action: 'status' }, makeCtx())).content as string) as {
        ok: boolean
        code: string
        git: {
          branch: { exitCode: number | null; stderr: string }
          status: { exitCode: number | null; stderr: string }
        }
      }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'git_status_failed')
      assert.equal(result.git.branch.exitCode, 128)
      assert.equal(result.git.status.exitCode, 128)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})
