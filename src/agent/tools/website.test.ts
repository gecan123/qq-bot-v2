import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import { createWebsiteTool, runWebsiteCommand, type WebsiteCommandRunner } from './website.js'
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
  await mkdir(join(dir, 'src/content/blog'), { recursive: true })
  await mkdir(join(dir, 'src/styles'), { recursive: true })
  await writeFile(join(dir, 'src/content/blog/hello.md'), '# hello\n', 'utf8')
  await writeFile(join(dir, 'src/styles/tokens.css'), ':root { --color-bg: #fff; }\n', 'utf8')
  return dir
}

function makeRunner(
  outputs: Record<string, {
    exitCode?: number | null
    stdout?: string
    stderr?: string
    stdoutTruncated?: boolean
    stderrTruncated?: boolean
  }> = {},
): WebsiteCommandRunner {
  return async (command) => {
    const key = [command.executable, ...command.args].join(' ')
    const output = outputs[key] ?? { stdout: '' }
    return {
      exitCode: output.exitCode ?? 0,
      stdout: output.stdout ?? '',
      stderr: output.stderr ?? '',
      timedOut: false,
      stdoutTruncated: output.stdoutTruncated ?? false,
      stderrTruncated: output.stderrTruncated ?? false,
    }
  }
}

async function runRealGit(repoDir: string, args: string[]): Promise<string> {
  const result = await runWebsiteCommand({
    executable: 'git',
    args,
    cwd: repoDir,
    timeoutMs: 10_000,
  })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(result.timedOut, false)
  return result.stdout
}

const WRITE_MAX_BYTES_FOR_TEST = 256 * 1024
const READ_MAX_BYTES_FOR_TEST = 256 * 1024

describe('website path policy', () => {
  test('allows supported Astro source trees and public static assets', () => {
    assert.equal(isAllowedWebsiteReadPath('src/content/blog/hello.md'), true)
    assert.equal(isAllowedWebsiteWritePath('src/content/blog/hello.md'), true)
    assert.equal(isAllowedWebsiteReadPath('src/content/blog/notes/today.mdx'), true)
    assert.equal(isAllowedWebsiteWritePath('src/content/blog/notes/today.mdx'), true)
    assert.equal(isAllowedWebsiteReadPath('src/content/CONTENT_GUIDE.md'), true)
    assert.equal(isAllowedWebsiteWritePath('src/content/categories.json'), true)
    assert.equal(isAllowedWebsiteReadPath('src/pages/blog/[category].astro'), true)
    assert.equal(isAllowedWebsiteWritePath('src/pages/blog/[category].astro'), true)
    assert.equal(isAllowedWebsiteReadPath('src/pages/rss.xml.js'), true)
    assert.equal(isAllowedWebsiteWritePath('src/pages/rss.xml.js'), true)
    assert.equal(isAllowedWebsiteReadPath('src/components/Header.astro'), true)
    assert.equal(isAllowedWebsiteWritePath('src/components/Header.astro'), true)
    assert.equal(isAllowedWebsiteReadPath('src/layouts/BlogPost.astro'), true)
    assert.equal(isAllowedWebsiteWritePath('src/styles/global.scss'), true)
    assert.equal(isAllowedWebsiteReadPath('src/content.config.ts'), true)
    assert.equal(isAllowedWebsiteWritePath('src/consts.ts'), true)
    assert.equal(isAllowedWebsiteReadPath('src/assets/fonts/site.woff2'), true)
    assert.equal(isAllowedWebsiteWritePath('src/assets/cover.avif'), true)
    assert.equal(isAllowedWebsiteReadPath('public/images/avatar.webp'), true)
    assert.equal(isAllowedWebsiteWritePath('public/images/avatar.webp'), true)
    assert.equal(isAllowedWebsiteReadPath('public/favicon.ico'), true)
    assert.equal(isAllowedWebsiteWritePath('public/manifest.webmanifest'), true)
    assert.equal(isAllowedWebsiteWritePath('public/sw.js'), true)
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
      'scripts/build.js',
      'src/generated/site.wasm',
      'public/archive.zip',
      'public/data.sqlite',
    ]

    for (const file of rejected) {
      assert.equal(isAllowedWebsiteReadPath(file), false, file)
      assert.equal(isAllowedWebsiteWritePath(file), false, file)
    }
  })

  test('rejects unsupported binary and archive extensions in editable trees', () => {
    const rejected = ['src/assets/model.bin', 'public/images/source.psd', 'public/download.tar']

    for (const file of rejected) {
      assert.equal(isAllowedWebsiteReadPath(file), false, file)
      assert.equal(isAllowedWebsiteWritePath(file), false, file)
    }
  })

  test('rejects unsupported extensions under Astro content', () => {
    const rejected = ['src/content/blog/archive.zip', 'src/content/blog/database.sqlite']

    for (const file of rejected) {
      assert.equal(isAllowedWebsiteReadPath(file), false, file)
      assert.equal(isAllowedWebsiteWritePath(file), false, file)
    }
  })

  test('normalizes safe relative paths', () => {
    assert.equal(safeWebsiteRelativePath('src/content/blog/hello.md'), 'src/content/blog/hello.md')
    assert.equal(safeWebsiteRelativePath('src/content/blog//hello.md'), 'src/content/blog/hello.md')
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
  test('guides the agent through the repository-owned category workflow', () => {
    const tool = createWebsiteTool({
      repoDir: '/tmp/luna-site',
      runner: makeRunner(),
    })

    assert.match(tool.description, /src\/content\/CONTENT_GUIDE\.md/)
    assert.match(tool.description, /src\/content\/categories\.json/)
    assert.match(tool.description, /src\/content\/examples\/category-entry\.json/)
    assert.match(tool.description, /src\/content\/examples\/article\.md/)
    assert.match(tool.description, /src\/content\/blog\/<category-id>\/<article-slug>/)
    assert.match(tool.description, /frontmatter 不写 category\/categories/)
  })

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
        file: 'src/content/blog/hello.md',
        maxChars: 20,
      }, makeCtx())).content as string) as { ok: boolean; file: string; content: string; truncated: boolean }

      assert.equal(result.ok, true)
      assert.equal(result.file, 'src/content/blog/hello.md')
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
        file: 'src/content/blog/missing.md',
      }, makeCtx())).content as string) as { ok: boolean; code: string }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'file_not_found')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('returns binary image metadata and revision without returning raw content', async () => {
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
      }, makeCtx())).content as string) as {
        ok: boolean
        binary: boolean
        bytes: number
        revision: string
        content: null
      }

      assert.equal(result.ok, true)
      assert.equal(result.binary, true)
      assert.equal(result.bytes, 4)
      assert.match(result.revision, /^[a-f0-9]{64}$/)
      assert.equal(result.content, null)
      assert.equal(isAllowedWebsiteWritePath('public/images/avatar.webp'), true)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('rejects oversized text reads before returning content', async () => {
    const repoDir = await makeSiteRepo()
    try {
      await writeFile(join(repoDir, 'src/content/blog/large.md'), `${'a'.repeat(READ_MAX_BYTES_FOR_TEST + 1)}\n`, 'utf8')
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'read',
        file: 'src/content/blog/large.md',
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
      await mkdir(join(repoDir, 'src/content/blog/dir.md'))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'read',
        file: 'src/content/blog/dir.md',
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
        file: 'src/content/blog/new.md',
        content: '# new\n',
      }, makeCtx())).content as string) as { ok: boolean; file: string; bytes: number }

      assert.equal(result.ok, true)
      assert.equal(result.file, 'src/content/blog/new.md')
      assert.equal(await readFile(join(repoDir, 'src/content/blog/new.md'), 'utf8'), '# new\n')
      assert.equal(result.bytes, Buffer.byteLength('# new\n'))
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('creates nested Astro category pages', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })
      const content = '---\nconst { category } = Astro.params\n---\n<h1>{category}</h1>\n'

      const written = JSON.parse((await tool.execute({
        action: 'write',
        file: 'src/pages/blog/[category].astro',
        content,
      }, makeCtx())).content as string) as { ok: boolean; file: string; revision: string }
      const read = JSON.parse((await tool.execute({
        action: 'read',
        file: 'src/pages/blog/[category].astro',
      }, makeCtx())).content as string) as { ok: boolean; content: string; revision: string }

      assert.equal(written.ok, true)
      assert.equal(written.file, 'src/pages/blog/[category].astro')
      assert.equal(read.ok, true)
      assert.equal(read.content, content)
      assert.equal(read.revision, written.revision)
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('protects overwrite, move, and delete with revisions', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })
      const read = JSON.parse((await tool.execute({
        action: 'read',
        file: 'src/content/blog/hello.md',
      }, makeCtx())).content as string) as { revision: string }
      const missingRevision = JSON.parse((await tool.execute({
        action: 'write',
        file: 'src/content/blog/hello.md',
        content: '# changed\n',
      }, makeCtx())).content as string) as { ok: boolean; code: string }
      assert.deepEqual({ ok: missingRevision.ok, code: missingRevision.code }, { ok: false, code: 'revision_required' })

      const written = JSON.parse((await tool.execute({
        action: 'write',
        file: 'src/content/blog/hello.md',
        content: '# changed\n',
        expectedRevision: read.revision,
      }, makeCtx())).content as string) as { ok: boolean; revision: string }
      assert.equal(written.ok, true)

      const moved = JSON.parse((await tool.execute({
        action: 'move',
        source: 'src/content/blog/hello.md',
        destination: 'src/content/blog/moved.md',
        expectedRevision: written.revision,
      }, makeCtx())).content as string) as { ok: boolean; revision: string }
      assert.equal(moved.ok, true)

      const deleted = JSON.parse((await tool.execute({
        action: 'delete',
        file: 'src/content/blog/moved.md',
        expectedRevision: moved.revision,
      }, makeCtx())).content as string) as { ok: boolean }
      assert.equal(deleted.ok, true)
      await assert.rejects(readFile(join(repoDir, 'src/content/blog/moved.md'), 'utf8'))
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('rejects writes to existing directories at allowed paths', async () => {
    const repoDir = await makeSiteRepo()
    try {
      await mkdir(join(repoDir, 'src/content/blog/dir.md'))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'write',
        file: 'src/content/blog/dir.md',
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
      await symlink(outsideFile, join(repoDir, 'src/content/blog/link.md'))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'read',
        file: 'src/content/blog/link.md',
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
      await symlink(outsideFile, join(repoDir, 'src/content/blog/link.md'))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'write',
        file: 'src/content/blog/link.md',
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
      await symlink(outsideDir, join(repoDir, 'src/content/blog/linkdir'))
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner: makeRunner(),
      })

      const result = JSON.parse((await tool.execute({
        action: 'write',
        file: 'src/content/blog/linkdir/sub/new.md',
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
        'git status --porcelain': { stdout: ' M src/content/blog/hello.md\n' },
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
      assert.deepEqual(result.changedFiles, ['src/content/blog/hello.md'])
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

  test('publish accepts and stages a new nested Astro category page', async () => {
    const repoDir = await makeSiteRepo()
    const commands: string[] = []
    try {
      const runner: WebsiteCommandRunner = async (command) => {
        const key = [command.executable, ...command.args].join(' ')
        commands.push(key)
        if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }
        if (key === 'git status --porcelain --untracked-files=all') return { exitCode: 0, stdout: '?? src/pages/blog/[category].astro\n', stderr: '', timedOut: false }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        if (key === 'git add -A -- src') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (key === 'git diff --cached --name-status') return { exitCode: 0, stdout: 'A\tsrc/pages/blog/[category].astro\n', stderr: '', timedOut: false }
        if (key.startsWith('git commit -m ')) return { exitCode: 0, stdout: '[main abc1234] site\n', stderr: '', timedOut: false }
        if (key === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: 'abc1234\n', stderr: '', timedOut: false }
        if (key === 'git push origin main') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        return { exitCode: 1, stdout: '', stderr: `unexpected command ${key}`, timedOut: false }
      }
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner,
      })

      const result = JSON.parse((await tool.execute({ action: 'publish' }, makeCtx())).content as string) as {
        ok: boolean
        publishStatus: string
        changedFiles: string[]
      }

      assert.equal(result.ok, true)
      assert.equal(result.publishStatus, 'pushed')
      assert.deepEqual(result.changedFiles, ['src/pages/blog/[category].astro'])
      assert.ok(commands.includes('git add -A -- src'))
      assert.ok(commands.includes('git push origin main'))
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish rejects dirty worktree with non-whitelisted changes', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const runner = makeRunner({
        'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
        'git status --porcelain --untracked-files=all': { stdout: ' M package.json\n M src/content/blog/hello.md\n' },
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

  test('publish rejects renames from non-whitelisted paths', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const runner: WebsiteCommandRunner = async (command) => {
        const key = [command.executable, ...command.args].join(' ')
        if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }
        if (key === 'git status --porcelain --untracked-files=all') return { exitCode: 0, stdout: 'R  package.json -> src/content/blog/hello.md\n', stderr: '', timedOut: false }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        if (key === 'git add src/content/blog/hello.md') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (key.startsWith('git commit -m ')) return { exitCode: 0, stdout: '[main abc1234] content\n', stderr: '', timedOut: false }
        if (key === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: 'abc1234\n', stderr: '', timedOut: false }
        if (key === 'git push origin main') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        return { exitCode: 1, stdout: '', stderr: `unexpected command ${key}`, timedOut: false }
      }
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

  test('publish stages both paths for allowed renames', async () => {
    const repoDir = await makeSiteRepo()
    const commands: string[] = []
    try {
      const runner: WebsiteCommandRunner = async (command) => {
        commands.push([command.executable, ...command.args].join(' '))
        const key = commands.at(-1)!
        if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }
        if (key === 'git status --porcelain --untracked-files=all') return { exitCode: 0, stdout: 'R  src/content/blog/old.md -> src/content/blog/new.md\n', stderr: '', timedOut: false }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        if (key === 'git add -A -- src/content') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (key === 'git diff --cached --name-status') return { exitCode: 0, stdout: 'R100\tsrc/content/blog/old.md\tsrc/content/blog/new.md\n', stderr: '', timedOut: false }
        if (key.startsWith('git commit -m ')) return { exitCode: 0, stdout: '[main abc1234] content\n', stderr: '', timedOut: false }
        if (key === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: 'abc1234\n', stderr: '', timedOut: false }
        if (key === 'git push origin main') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        return { exitCode: 1, stdout: '', stderr: `unexpected command ${key}`, timedOut: false }
      }
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner,
      })

      const result = JSON.parse((await tool.execute({ action: 'publish' }, makeCtx())).content as string) as {
        ok: boolean
        changedFiles: string[]
      }

      assert.equal(result.ok, true)
      assert.deepEqual(result.changedFiles, ['src/content/blog/old.md', 'src/content/blog/new.md'])
      assert.deepEqual(commands, [
        'git rev-parse --abbrev-ref HEAD',
        'git status --porcelain --untracked-files=all',
        'pnpm build',
        'git status --porcelain --untracked-files=all',
        'git add -A -- src/content',
        'git diff --cached --name-status',
        'git commit -m content: Luna 更新个人网站',
        'git rev-parse --short HEAD',
        'git push origin main',
      ])
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish stages safe deletions with allowlisted pathspecs', async () => {
    const repoDir = await makeSiteRepo()
    const commands: string[] = []
    try {
      const runner: WebsiteCommandRunner = async (command) => {
        commands.push([command.executable, ...command.args].join(' '))
        const key = commands.at(-1)!
        if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }
        if (key === 'git status --porcelain --untracked-files=all') return { exitCode: 0, stdout: ' D src/content/blog/old.md\n', stderr: '', timedOut: false }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        if (key === 'git add -A -- src/content') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (key === 'git diff --cached --name-status') return { exitCode: 0, stdout: 'D\tsrc/content/blog/old.md\n', stderr: '', timedOut: false }
        if (key.startsWith('git commit -m ')) return { exitCode: 0, stdout: '[main abc1234] content\n', stderr: '', timedOut: false }
        if (key === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: 'abc1234\n', stderr: '', timedOut: false }
        if (key === 'git push origin main') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        return { exitCode: 1, stdout: '', stderr: `unexpected command ${key}`, timedOut: false }
      }
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner,
      })

      const result = JSON.parse((await tool.execute({ action: 'publish' }, makeCtx())).content as string) as {
        ok: boolean
        changedFiles: string[]
      }

      assert.equal(result.ok, true)
      assert.deepEqual(result.changedFiles, ['src/content/blog/old.md'])
      assert.deepEqual(commands, [
        'git rev-parse --abbrev-ref HEAD',
        'git status --porcelain --untracked-files=all',
        'pnpm build',
        'git status --porcelain --untracked-files=all',
        'git add -A -- src/content',
        'git diff --cached --name-status',
        'git commit -m content: Luna 更新个人网站',
        'git rev-parse --short HEAD',
        'git push origin main',
      ])
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish accepts nested untracked safe files', async () => {
    const repoDir = await makeSiteRepo()
    const commands: string[] = []
    try {
      const runner: WebsiteCommandRunner = async (command) => {
        commands.push([command.executable, ...command.args].join(' '))
        const key = commands.at(-1)!
        if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }
        if (key === 'git status --porcelain --untracked-files=all') return { exitCode: 0, stdout: '?? src/content/blog/newdir/file.md\n', stderr: '', timedOut: false }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        if (key === 'git add -A -- src/content') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (key === 'git diff --cached --name-status') return { exitCode: 0, stdout: 'A\tsrc/content/blog/newdir/file.md\n', stderr: '', timedOut: false }
        if (key.startsWith('git commit -m ')) return { exitCode: 0, stdout: '[main abc1234] content\n', stderr: '', timedOut: false }
        if (key === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: 'abc1234\n', stderr: '', timedOut: false }
        if (key === 'git push origin main') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        return { exitCode: 1, stdout: '', stderr: `unexpected command ${key}`, timedOut: false }
      }
      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'pnpm build',
        commandTimeoutMs: 60_000,
        runner,
      })

      const result = JSON.parse((await tool.execute({ action: 'publish' }, makeCtx())).content as string) as {
        ok: boolean
        changedFiles: string[]
      }

      assert.equal(result.ok, true)
      assert.deepEqual(result.changedFiles, ['src/content/blog/newdir/file.md'])
      assert.deepEqual(commands, [
        'git rev-parse --abbrev-ref HEAD',
        'git status --porcelain --untracked-files=all',
        'pnpm build',
        'git status --porcelain --untracked-files=all',
        'git add -A -- src/content',
        'git diff --cached --name-status',
        'git commit -m content: Luna 更新个人网站',
        'git rev-parse --short HEAD',
        'git push origin main',
      ])
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish rejects unsafe files created by check before staging', async () => {
    const repoDir = await makeSiteRepo()
    const commands: string[] = []
    let statusCalls = 0
    try {
      const runner: WebsiteCommandRunner = async (command) => {
        commands.push([command.executable, ...command.args].join(' '))
        const key = commands.at(-1)!
        if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }
        if (key === 'git status --porcelain --untracked-files=all') {
          statusCalls += 1
          return {
            exitCode: 0,
            stdout: statusCalls === 1
              ? ' M src/content/blog/hello.md\n'
              : ' M src/content/blog/hello.md\n?? src/content/.draft.md\n',
            stderr: '',
            timedOut: false,
          }
        }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        return { exitCode: 1, stdout: '', stderr: `unexpected command ${key}`, timedOut: false }
      }
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
        changedFiles: string[]
      }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'unsafe_dirty_worktree')
      assert.deepEqual(result.unsafeFiles, ['src/content/.draft.md'])
      assert.deepEqual(result.changedFiles, ['src/content/blog/hello.md', 'src/content/.draft.md'])
      assert.deepEqual(commands, [
        'git rev-parse --abbrev-ref HEAD',
        'git status --porcelain --untracked-files=all',
        'pnpm build',
        'git status --porcelain --untracked-files=all',
      ])
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish rejects unsafe files created by real check command before staging', async () => {
    const repoDir = await makeSiteRepo()
    try {
      await writeFile(
        join(repoDir, 'check.mjs'),
        "import { writeFileSync } from 'node:fs'\nwriteFileSync('src/content/.draft.md', 'draft\\n')\n",
        'utf8',
      )
      await runRealGit(repoDir, ['init'])
      await runRealGit(repoDir, ['checkout', '-b', 'main'])
      await runRealGit(repoDir, ['config', 'user.email', 'luna@example.com'])
      await runRealGit(repoDir, ['config', 'user.name', 'Luna'])
      await runRealGit(repoDir, ['add', 'check.mjs', 'src/content/blog/hello.md'])
      await runRealGit(repoDir, ['commit', '-m', 'init'])
      await writeFile(join(repoDir, 'src/content/blog/hello.md'), '# changed\n', 'utf8')

      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'node check.mjs',
        commandTimeoutMs: 10_000,
      })

      const result = JSON.parse((await tool.execute({ action: 'publish' }, makeCtx())).content as string) as {
        ok: boolean
        code: string
        unsafeFiles: string[]
      }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'unsafe_dirty_worktree')
      assert.deepEqual(result.unsafeFiles, ['src/content/.draft.md'])
      assert.equal(await runRealGit(repoDir, ['diff', '--cached', '--name-only']), '')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish rejects real staged typechanges at allowed paths', async () => {
    const repoDir = await makeSiteRepo()
    try {
      await runRealGit(repoDir, ['init'])
      await runRealGit(repoDir, ['checkout', '-b', 'main'])
      await runRealGit(repoDir, ['config', 'user.email', 'luna@example.com'])
      await runRealGit(repoDir, ['config', 'user.name', 'Luna'])
      await runRealGit(repoDir, ['add', 'src/content/blog/hello.md'])
      await runRealGit(repoDir, ['commit', '-m', 'init'])
      const initialCommit = (await runRealGit(repoDir, ['rev-parse', 'HEAD'])).trim()

      await rm(join(repoDir, 'src/content/blog/hello.md'), { force: true })
      await symlink('/tmp/luna-site-target', join(repoDir, 'src/content/blog/hello.md'))

      const tool = createWebsiteTool({
        repoDir,
        branch: 'main',
        checkCommand: 'git status',
        commandTimeoutMs: 10_000,
      })

      const result = JSON.parse((await tool.execute({ action: 'publish' }, makeCtx())).content as string) as {
        ok: boolean
        code: string
        unsafeFiles: string[]
      }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'unsafe_staged_index')
      assert.deepEqual(result.unsafeFiles, ['src/content/blog/hello.md'])
      assert.equal((await runRealGit(repoDir, ['rev-parse', 'HEAD'])).trim(), initialCommit)
      assert.equal(await runRealGit(repoDir, ['diff', '--cached', '--name-status']), '')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish rejects truncated status output before staging', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const runner = makeRunner({
        'git rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
        'git status --porcelain --untracked-files=all': {
          stdout: ' M src/content/blog/hello.md\n',
          stdoutTruncated: true,
        },
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
      }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'git_output_truncated')
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish rejects truncated staged diff output and cleans up staging specs', async () => {
    const repoDir = await makeSiteRepo()
    const commands: string[] = []
    try {
      const runner: WebsiteCommandRunner = async (command) => {
        commands.push([command.executable, ...command.args].join(' '))
        const key = commands.at(-1)!
        if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }
        if (key === 'git status --porcelain --untracked-files=all') return { exitCode: 0, stdout: ' M src/content/blog/hello.md\n', stderr: '', timedOut: false }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        if (key === 'git add -A -- src/content') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (key === 'git diff --cached --name-status') {
          return {
            exitCode: 0,
            stdout: 'M\tsrc/content/blog/hello.md\n',
            stderr: '',
            timedOut: false,
            stdoutTruncated: true,
          }
        }
        if (key === 'git reset -- src/content') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        return { exitCode: 1, stdout: '', stderr: `unexpected command ${key}`, timedOut: false }
      }
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
      }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'git_output_truncated')
      assert.deepEqual(commands, [
        'git rev-parse --abbrev-ref HEAD',
        'git status --porcelain --untracked-files=all',
        'pnpm build',
        'git status --porcelain --untracked-files=all',
        'git add -A -- src/content',
        'git diff --cached --name-status',
        'git reset -- src/content',
      ])
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish rejects unsafe staged index and cleans up staging specs', async () => {
    const repoDir = await makeSiteRepo()
    const commands: string[] = []
    try {
      const runner: WebsiteCommandRunner = async (command) => {
        commands.push([command.executable, ...command.args].join(' '))
        const key = commands.at(-1)!
        if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }
        if (key === 'git status --porcelain --untracked-files=all') return { exitCode: 0, stdout: ' M src/content/blog/hello.md\n', stderr: '', timedOut: false }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        if (key === 'git add -A -- src/content') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (key === 'git diff --cached --name-status') return { exitCode: 0, stdout: 'M\tsrc/content/blog/hello.md\nA\tsrc/content/.draft.md\n', stderr: '', timedOut: false }
        if (key === 'git reset -- src/content') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        return { exitCode: 1, stdout: '', stderr: `unexpected command ${key}`, timedOut: false }
      }
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
      assert.equal(result.code, 'unsafe_staged_index')
      assert.deepEqual(result.unsafeFiles, ['src/content/.draft.md'])
      assert.deepEqual(commands, [
        'git rev-parse --abbrev-ref HEAD',
        'git status --porcelain --untracked-files=all',
        'pnpm build',
        'git status --porcelain --untracked-files=all',
        'git add -A -- src/content',
        'git diff --cached --name-status',
        'git reset -- src/content',
      ])
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  test('publish reports commit when push fails after commit', async () => {
    const repoDir = await makeSiteRepo()
    try {
      const runner: WebsiteCommandRunner = async (command) => {
        const key = [command.executable, ...command.args].join(' ')
        if (key === 'git rev-parse --abbrev-ref HEAD') return { exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }
        if (key === 'git status --porcelain --untracked-files=all') return { exitCode: 0, stdout: ' M src/content/blog/hello.md\n', stderr: '', timedOut: false }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        if (key === 'git add -A -- src/content') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (key === 'git diff --cached --name-status') return { exitCode: 0, stdout: 'M\tsrc/content/blog/hello.md\n', stderr: '', timedOut: false }
        if (key.startsWith('git commit -m ')) return { exitCode: 0, stdout: '[main abc1234] content\n', stderr: '', timedOut: false }
        if (key === 'git rev-parse --short HEAD') return { exitCode: 0, stdout: 'abc1234\n', stderr: '', timedOut: false }
        if (key === 'git push origin main') return { exitCode: 1, stdout: '', stderr: 'rejected\n', timedOut: false }
        return { exitCode: 1, stdout: '', stderr: `unexpected command ${key}`, timedOut: false }
      }
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
        commit: string
        branch: string
      }

      assert.equal(result.ok, false)
      assert.equal(result.code, 'push_failed')
      assert.equal(result.commit, 'abc1234')
      assert.equal(result.branch, 'main')
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
        if (key === 'git status --porcelain --untracked-files=all') return { exitCode: 0, stdout: ' M src/content/blog/hello.md\n', stderr: '', timedOut: false }
        if (key === 'pnpm build') return { exitCode: 0, stdout: 'built\n', stderr: '', timedOut: false }
        if (key === 'git add -A -- src/content') return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
        if (key === 'git diff --cached --name-status') return { exitCode: 0, stdout: 'M\tsrc/content/blog/hello.md\n', stderr: '', timedOut: false }
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
        publishStatus: string
        deploymentStatus: string
        commit: string
        changedFiles: string[]
        publicUrl: string
        next: string
      }

      assert.equal(result.ok, true)
      assert.equal(result.publishStatus, 'pushed')
      assert.equal(result.deploymentStatus, 'unverified')
      assert.equal(result.commit, 'abc1234')
      assert.deepEqual(result.changedFiles, ['src/content/blog/hello.md'])
      assert.equal(result.publicUrl, 'https://luna.example.com')
      assert.match(result.next, /Git push succeeded.*Vercel deployment is not verified.*publicUrl.*live/)
      assert.deepEqual(commands, [
        'git rev-parse --abbrev-ref HEAD',
        'git status --porcelain --untracked-files=all',
        'pnpm build',
        'git status --porcelain --untracked-files=all',
        'git add -A -- src/content',
        'git diff --cached --name-status',
        'git commit -m content: 更新 hello',
        'git rev-parse --short HEAD',
        'git push origin main',
      ])
    } finally {
      await rm(repoDir, { recursive: true, force: true })
    }
  })
})
