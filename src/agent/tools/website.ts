import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool } from '../tool.js'
import { config } from '../../config/index.js'

const DEFAULT_READ_MAX_CHARS = 12_000
const READ_MAX_CHARS_CAP = 50_000
const READ_MAX_BYTES = 256 * 1024
const WRITE_MAX_BYTES = 256 * 1024
const WRITE_CONTENT_MAX_CHARS = Math.ceil(WRITE_MAX_BYTES / 3) * 4 + 16
const COMMAND_OUTPUT_CAP = 4_000
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)

const WEBSITE_TEXT_EXTENSIONS = new Set([
  '.astro',
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.less',
  '.md',
  '.mdx',
  '.mjs',
  '.sass',
  '.scss',
  '.svelte',
  '.svg',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.webmanifest',
  '.xml',
])
const WEBSITE_BINARY_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.otf',
  '.png',
  '.ttf',
  '.webp',
  '.woff',
  '.woff2',
])

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
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
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

const argsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({
    action: z.literal('read'),
    file: z.string().trim().min(1).max(240),
    maxChars: z.number().int().min(100).max(READ_MAX_CHARS_CAP).optional(),
  }),
  z.object({
    action: z.literal('write'),
    file: z.string().trim().min(1).max(240),
    content: z.string().max(WRITE_CONTENT_MAX_CHARS),
    encoding: z.enum(['utf8', 'base64']).optional(),
    expectedRevision: revisionSchema.optional(),
  }),
  z.object({
    action: z.literal('delete'),
    file: z.string().trim().min(1).max(240),
    expectedRevision: revisionSchema,
  }),
  z.object({
    action: z.literal('move'),
    source: z.string().trim().min(1).max(240),
    destination: z.string().trim().min(1).max(240),
    expectedRevision: revisionSchema,
  }),
  z.object({
    action: z.literal('publish'),
    message: z.string().trim().min(1).max(120).optional(),
  }),
])

type Args = z.infer<typeof argsSchema>

interface WebsiteRuntimeConfig {
  repoDir: string
  publicUrl?: string
  branch: string
  checkCommand: string
  commandTimeoutMs: number
  runner: WebsiteCommandRunner
}

export function maybeCreateWebsiteTool(deps: WebsiteToolDeps = {}): Tool<Args> | null {
  const repoDir = deps.repoDir ?? config.website?.repoDir
  if (!repoDir) return null
  return createWebsiteTool(deps)
}

export function createWebsiteTool(deps: WebsiteToolDeps): Tool<Args> {
  const repoDir = deps.repoDir ?? config.website?.repoDir
  if (!repoDir) {
    throw new Error('website repoDir is required')
  }

  const runtime: WebsiteRuntimeConfig = {
    repoDir: resolve(repoDir),
    publicUrl: deps.publicUrl ?? config.website?.publicUrl,
    branch: deps.branch ?? config.website?.branch ?? 'main',
    checkCommand: deps.checkCommand ?? config.website?.checkCommand ?? 'pnpm build',
    commandTimeoutMs: deps.commandTimeoutMs ?? config.website?.commandTimeoutMs ?? 60_000,
    runner: deps.runner ?? runWebsiteCommand,
  }

  return {
    name: 'website',
    description: [
      '管理 Luna 个人网站仓库的受控工具.',
      '支持 status 查看仓库状态, read 读取允许路径, write 写入, delete 删除, move 移动, publish 检查并发布允许路径变更.',
      'read 返回 revision; 覆盖、删除或移动已有文件必须携带最新 revision.',
      '管理分类或文章前必须先 read src/content/CONTENT_GUIDE.md 和 src/content/categories.json，并严格按实时指南操作；需要模板时 read src/content/examples/category-entry.json 或 src/content/examples/article.md.',
      '新分类登记在 src/content/categories.json；文章只能写入 src/content/blog/<category-id>/<article-slug>.md 或 .mdx，所属分类由目录决定，frontmatter 不写 category/categories.',
      '文章 frontmatter 使用 title, description, pubDate, tags, draft，可选 updatedDate/cover；不要使用 date 代替 pubDate.',
      '可读写 src/** 下受支持的 Astro 源码、内容、样式与素材，以及 public/** 下受支持的静态资源; 可以建立页面、组件、布局和内容分类结构.',
      '不要读写仓库根配置、依赖、CI、部署配置、脚本、隐藏文件或路径逃逸.',
      'publish 成功只表示构建通过且 Git commit/push 成功, 不表示 Vercel 已部署完成; 未确认正式 URL 可见目标内容前不得宣称已经上线.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = rawArgs as Args
      if (args.action === 'status') return status(runtime)
      if (args.action === 'read') return readWebsiteFile(runtime, args)
      if (args.action === 'write') return writeWebsiteFile(runtime, args)
      if (args.action === 'delete') return deleteWebsiteFile(runtime, args)
      if (args.action === 'move') return moveWebsiteFile(runtime, args)
      return publishWebsite(runtime, args)
    },
  }
}

async function status(runtime: WebsiteRuntimeConfig) {
  const [branch, remote, latestCommit, porcelain] = await Promise.all([
    runGit(runtime, ['rev-parse', '--abbrev-ref', 'HEAD']),
    runGit(runtime, ['remote', 'get-url', 'origin']),
    runGit(runtime, ['rev-parse', '--short', 'HEAD']),
    runGit(runtime, ['status', '--porcelain']),
  ])

  const changedFiles = parsePorcelainFiles(porcelain.stdout).slice(0, 50)
  const git = {
    branch: commandSummary(branch),
    remote: commandSummary(remote),
    latestCommit: commandSummary(latestCommit),
    status: commandSummary(porcelain),
  }
  const essentialFailed = commandFailed(branch) || commandFailed(porcelain)
  if (essentialFailed) {
    return jsonResult({
      ok: false,
      code: 'git_status_failed',
      repoDir: runtime.repoDir,
      publicUrl: runtime.publicUrl,
      branch: branch.stdout.trim() || runtime.branch,
      remote: remote.stdout.trim(),
      latestCommit: latestCommit.stdout.trim(),
      dirty: changedFiles.length > 0,
      changedFiles,
      git,
    })
  }

  return jsonResult({
    ok: true,
    repoDir: runtime.repoDir,
    publicUrl: runtime.publicUrl,
    branch: branch.stdout.trim() || runtime.branch,
    remote: remote.stdout.trim(),
    latestCommit: latestCommit.stdout.trim(),
    dirty: changedFiles.length > 0,
    changedFiles,
    git,
  })
}

async function readWebsiteFile(runtime: WebsiteRuntimeConfig, args: Extract<Args, { action: 'read' }>) {
  if (!isAllowedWebsiteReadPath(args.file)) {
    return jsonResult({ ok: false, code: 'path_not_allowed', file: args.file })
  }

  const relativePath = safeWebsiteRelativePath(args.file)
  const isText = relativePath ? WEBSITE_TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase()) : false

  const fileTarget = await existingSitePath(runtime.repoDir, args.file)
  if (fileTarget === 'not_found') {
    return jsonResult({ ok: false, code: 'file_not_found', file: relativePath ?? args.file })
  }
  if (fileTarget === 'not_regular_file') {
    return jsonResult({ ok: false, code: 'not_regular_file', file: relativePath ?? args.file })
  }
  if (!relativePath || !fileTarget) {
    return jsonResult({ ok: false, code: 'path_not_allowed', file: args.file })
  }
  if (fileTarget.size > READ_MAX_BYTES) {
    return jsonResult({
      ok: false,
      code: 'file_too_large',
      file: relativePath,
      bytes: fileTarget.size,
      maxBytes: READ_MAX_BYTES,
    })
  }

  const bytes = await readFile(fileTarget.path)
  if (!isText) {
    return jsonResult({
      ok: true,
      file: relativePath,
      binary: true,
      bytes: bytes.byteLength,
      revision: revisionOf(bytes),
      content: null,
      truncated: false,
    })
  }

  const maxChars = args.maxChars ?? DEFAULT_READ_MAX_CHARS
  const content = bytes.toString('utf8')
  const truncated = content.length > maxChars
  return jsonResult({
    ok: true,
    file: relativePath,
    content: truncated ? content.slice(0, maxChars) : content,
    truncated,
    chars: Math.min(content.length, maxChars),
    totalChars: content.length,
    revision: revisionOf(content),
  })
}

async function writeWebsiteFile(runtime: WebsiteRuntimeConfig, args: Extract<Args, { action: 'write' }>) {
  if (!isAllowedWebsiteWritePath(args.file)) {
    return jsonResult({ ok: false, code: 'path_not_allowed', file: args.file })
  }

  const relativePath = safeWebsiteRelativePath(args.file)
  const existing = await existingSitePath(runtime.repoDir, args.file)
  if (existing !== 'not_found') {
    if (existing === 'not_regular_file') return jsonResult({ ok: false, code: 'not_regular_file', file: relativePath ?? args.file })
    if (!existing || !relativePath) return jsonResult({ ok: false, code: 'path_not_allowed', file: args.file })
    if (!args.expectedRevision) return jsonResult({ ok: false, code: 'revision_required', file: relativePath })
    const current = await readFile(existing.path)
    if (revisionOf(current) !== args.expectedRevision) return jsonResult({ ok: false, code: 'revision_conflict', file: relativePath })
  } else if (args.expectedRevision) {
    return jsonResult({ ok: false, code: 'file_not_found', file: relativePath ?? args.file })
  }
  const absolutePath = await writableSitePath(runtime.repoDir, args.file)
  if (absolutePath === 'not_regular_file') {
    return jsonResult({ ok: false, code: 'not_regular_file', file: relativePath ?? args.file })
  }
  if (!relativePath || !absolutePath) {
    return jsonResult({ ok: false, code: 'path_not_allowed', file: args.file })
  }

  const bytes = args.encoding === 'base64'
    ? Buffer.from(args.content, 'base64')
    : Buffer.from(args.content, 'utf8')

  if (bytes.byteLength > WRITE_MAX_BYTES) {
    return jsonResult({
      ok: false,
      code: 'file_too_large',
      file: relativePath,
      bytes: bytes.byteLength,
      maxBytes: WRITE_MAX_BYTES,
    })
  }

  await atomicWrite(absolutePath, bytes)
  return jsonResult({ ok: true, file: relativePath, bytes: bytes.byteLength, revision: revisionOf(bytes) })
}

async function deleteWebsiteFile(runtime: WebsiteRuntimeConfig, args: Extract<Args, { action: 'delete' }>) {
  if (!isAllowedWebsiteWritePath(args.file)) return jsonResult({ ok: false, code: 'path_not_allowed', file: args.file })
  const relativePath = safeWebsiteRelativePath(args.file)
  const target = await existingSitePath(runtime.repoDir, args.file)
  if (target === 'not_found') return jsonResult({ ok: false, code: 'file_not_found', file: relativePath ?? args.file })
  if (target === 'not_regular_file') return jsonResult({ ok: false, code: 'not_regular_file', file: relativePath ?? args.file })
  if (!relativePath || !target) return jsonResult({ ok: false, code: 'path_not_allowed', file: args.file })
  const current = await readFile(target.path)
  if (revisionOf(current) !== args.expectedRevision) return jsonResult({ ok: false, code: 'revision_conflict', file: relativePath })
  await rm(target.path)
  return jsonResult({ ok: true, action: 'delete', file: relativePath })
}

async function moveWebsiteFile(runtime: WebsiteRuntimeConfig, args: Extract<Args, { action: 'move' }>) {
  if (!isAllowedWebsiteWritePath(args.source) || !isAllowedWebsiteWritePath(args.destination)) {
    return jsonResult({ ok: false, code: 'path_not_allowed', source: args.source, destination: args.destination })
  }
  const source = safeWebsiteRelativePath(args.source)
  const destination = safeWebsiteRelativePath(args.destination)
  const sourceTarget = await existingSitePath(runtime.repoDir, args.source)
  if (sourceTarget === 'not_found') return jsonResult({ ok: false, code: 'file_not_found', file: source ?? args.source })
  if (sourceTarget === 'not_regular_file') return jsonResult({ ok: false, code: 'not_regular_file', file: source ?? args.source })
  if (!source || !destination || !sourceTarget) return jsonResult({ ok: false, code: 'path_not_allowed' })
  const destinationExisting = await existingSitePath(runtime.repoDir, args.destination)
  if (destinationExisting !== 'not_found') return jsonResult({ ok: false, code: 'destination_exists', file: destination })
  const current = await readFile(sourceTarget.path)
  if (revisionOf(current) !== args.expectedRevision) return jsonResult({ ok: false, code: 'revision_conflict', file: source })
  const destinationPath = await writableSitePath(runtime.repoDir, args.destination)
  if (!destinationPath || destinationPath === 'not_regular_file') return jsonResult({ ok: false, code: 'path_not_allowed', file: destination })
  await rename(sourceTarget.path, destinationPath)
  return jsonResult({ ok: true, action: 'move', source, destination, revision: args.expectedRevision })
}

function revisionOf(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(tempPath, bytes)
    await rename(tempPath, path)
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

async function publishWebsite(runtime: WebsiteRuntimeConfig, args: Extract<Args, { action: 'publish' }>) {
  const branchResult = await runGit(runtime, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (commandFailed(branchResult)) {
    return failedCommand('branch_failed', 'failed to read current branch', branchResult)
  }

  const currentBranch = branchResult.stdout.trim()
  if (currentBranch !== runtime.branch) {
    return jsonResult({
      ok: false,
      code: 'wrong_branch',
      branch: currentBranch,
      expectedBranch: runtime.branch,
    })
  }

  const changedFiles = await readPublishChangedFiles(runtime)
  if ('content' in changedFiles) return changedFiles
  if (changedFiles.length === 0) {
    return jsonResult({
      ok: false,
      code: 'nothing_to_publish',
      branch: runtime.branch,
      changedFiles,
    })
  }

  const unsafeFiles = changedFiles.filter((file) => !isAllowedWebsiteWritePath(file))
  if (unsafeFiles.length > 0) {
    return jsonResult({
      ok: false,
      code: 'unsafe_dirty_worktree',
      unsafeFiles,
      changedFiles,
    })
  }

  const checkResult = await runConfiguredCheck(
    runtime.runner,
    runtime.repoDir,
    runtime.commandTimeoutMs,
    runtime.checkCommand,
  )
  if (commandFailed(checkResult)) {
    return failedCommand('check_failed', 'configured check command failed', checkResult)
  }

  const postCheckChangedFiles = await readPublishChangedFiles(runtime)
  if ('content' in postCheckChangedFiles) return postCheckChangedFiles
  const postCheckUnsafeFiles = postCheckChangedFiles.filter((file) => !isAllowedWebsiteWritePath(file))
  if (postCheckUnsafeFiles.length > 0) {
    return jsonResult({
      ok: false,
      code: 'unsafe_dirty_worktree',
      unsafeFiles: postCheckUnsafeFiles,
      changedFiles: postCheckChangedFiles,
    })
  }

  const stageSpecs = publishStageSpecs(postCheckChangedFiles)
  if (stageSpecs.length === 0) {
    return jsonResult({
      ok: false,
      code: 'staging_policy_failed',
      error: 'no safe staging pathspecs were derived for website changes',
      changedFiles: postCheckChangedFiles,
    })
  }
  const addResult = await runGit(runtime, ['add', '-A', '--', ...stageSpecs])
  if (commandFailed(addResult)) {
    return failedCommand('add_failed', 'failed to stage website changes', addResult)
  }

  const stagedResult = await runGit(runtime, ['diff', '--cached', '--name-status'])
  if (commandFailed(stagedResult)) {
    return failedCommand('staged_diff_failed', 'failed to inspect staged website changes', stagedResult)
  }
  if (stagedResult.stdoutTruncated) {
    const cleanup = await runGit(runtime, ['reset', '--', ...stageSpecs])
    return truncatedMachineOutput('staged_diff', stagedResult, { cleanup: commandSummary(cleanup) })
  }
  const stagedInspection = parseStagedNameStatus(stagedResult.stdout)
  const unsafeStagedFiles = uniqueStrings([
    ...stagedInspection.files.filter((file) => !isAllowedWebsiteWritePath(file)),
    ...stagedInspection.unsupportedFiles,
  ])
  if (unsafeStagedFiles.length > 0 || stagedInspection.unsupportedEntries.length > 0) {
    const cleanup = await runGit(runtime, ['reset', '--', ...stageSpecs])
    return jsonResult({
      ok: false,
      code: 'unsafe_staged_index',
      unsafeFiles: unsafeStagedFiles,
      changedFiles: postCheckChangedFiles,
      stagedFiles: stagedInspection.files,
      unsupportedStagedEntries: stagedInspection.unsupportedEntries,
      cleanup: commandSummary(cleanup),
    })
  }

  const commitMessage = args.message ?? 'content: Luna 更新个人网站'
  const commitResult = await runGit(runtime, ['commit', '-m', commitMessage])
  if (commandFailed(commitResult)) {
    return failedCommand('commit_failed', 'failed to commit website changes', commitResult)
  }

  const hashResult = await runGit(runtime, ['rev-parse', '--short', 'HEAD'])
  if (commandFailed(hashResult)) {
    return failedCommand('hash_failed', 'failed to read published commit hash', hashResult)
  }

  const pushResult = await runGit(runtime, ['push', 'origin', runtime.branch])
  if (commandFailed(pushResult)) {
    return failedCommand('push_failed', 'failed to push website commit', pushResult, {
      branch: runtime.branch,
      commit: hashResult.stdout.trim(),
    })
  }

  return jsonResult({
    ok: true,
    publishStatus: 'pushed',
    deploymentStatus: 'unverified',
    branch: runtime.branch,
    commit: hashResult.stdout.trim(),
    changedFiles: postCheckChangedFiles,
    ...(runtime.publicUrl ? { publicUrl: runtime.publicUrl } : {}),
    check: {
      ok: true,
      stdout: clip(checkResult.stdout, 1_000),
      stderr: clip(checkResult.stderr, 1_000),
    },
    next: 'Git push succeeded. Vercel deployment is not verified yet; check the deployment and confirm the expected page on publicUrl before describing the content as live.',
  })
}

type ExistingSitePathResult = null | 'not_found' | 'not_regular_file' | {
  path: string
  size: number
}

async function existingSitePath(repoDir: string, file: string): Promise<ExistingSitePathResult> {
  const absolutePath = sitePath(repoDir, file)
  if (!absolutePath) return null

  let stats
  try {
    stats = await lstat(absolutePath)
  } catch (err) {
    if (isNotFoundError(err)) return 'not_found'
    throw err
  }
  if (stats.isSymbolicLink()) return null
  if (!stats.isFile()) return 'not_regular_file'

  const root = await realpath(repoDir)
  const target = await realpath(absolutePath)
  if (!isPathInside(root, target)) return null
  return { path: target, size: stats.size }
}

async function writableSitePath(repoDir: string, file: string): Promise<string | null | 'not_regular_file'> {
  const relativePath = safeWebsiteRelativePath(file)
  if (!relativePath) return null
  const absolutePath = sitePath(repoDir, file)
  if (!absolutePath) return null

  const root = await realpath(repoDir)
  const rootLexical = resolve(repoDir)
  const parentRelative = dirname(relativePath)
  const parentSegments = parentRelative === '.' ? [] : parentRelative.split('/')
  let current = rootLexical

  for (const segment of parentSegments) {
    current = join(current, segment)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink() || !stats.isDirectory()) return null
      const target = await realpath(current)
      if (!isPathInside(root, target)) return null
    } catch (err) {
      if (!isNotFoundError(err)) throw err
      break
    }
  }

  await mkdir(dirname(absolutePath), { recursive: true })
  const parent = await realpath(dirname(absolutePath))
  if (!isPathInside(root, parent)) return null

  try {
    const stats = await lstat(absolutePath)
    if (stats.isSymbolicLink()) return null
    if (!stats.isFile()) return 'not_regular_file'
    const target = await realpath(absolutePath)
    if (!isPathInside(root, target)) return null
  } catch (err) {
    if (!isNotFoundError(err)) throw err
  }

  return absolutePath
}

function sitePath(repoDir: string, file: string): string | null {
  const relativePath = safeWebsiteRelativePath(file)
  if (!relativePath) return null

  const root = resolve(repoDir)
  const fullPath = resolve(join(root, relativePath))
  if (fullPath !== root && !fullPath.startsWith(`${root}/`)) return null
  return fullPath
}

function isPathInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`)
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}

function runGit(runtime: WebsiteRuntimeConfig, args: string[]): Promise<WebsiteCommandRunResult> {
  return runtime.runner({
    executable: 'git',
    args,
    cwd: runtime.repoDir,
    timeoutMs: runtime.commandTimeoutMs,
  })
}

async function readPublishChangedFiles(runtime: WebsiteRuntimeConfig) {
  const statusResult = await runGit(runtime, ['status', '--porcelain', '--untracked-files=all'])
  if (commandFailed(statusResult)) {
    return failedCommand('status_failed', 'failed to read git status', statusResult)
  }
  if (statusResult.stdoutTruncated) {
    return truncatedMachineOutput('status', statusResult)
  }
  return parsePorcelainPublishPaths(statusResult.stdout)
}

function runConfiguredCheck(
  runner: WebsiteCommandRunner,
  cwd: string,
  timeoutMs: number,
  checkCommand: string,
): Promise<WebsiteCommandRunResult> {
  const [executable, ...args] = checkCommand.trim().split(/\s+/).filter(Boolean)
  if (!executable) {
    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: 'check command is empty',
      timedOut: false,
    })
  }
  return runner({ executable, args, cwd, timeoutMs })
}

export function runWebsiteCommand(input: WebsiteCommandRunInput): Promise<WebsiteCommandRunResult> {
  return new Promise((resolvePromise) => {
    const useProcessGroup = process.platform !== 'win32'
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      detached: useProcessGroup,
      env: minimalEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let settled = false
    let timedOut = false
    let killTimeout: NodeJS.Timeout | null = null
    let killEscalated = false
    let pendingResult: WebsiteCommandRunResult | null = null

    const resolveNow = (result: WebsiteCommandRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimeout) clearTimeout(killTimeout)
      resolvePromise(result)
    }

    const resolveAfterCleanup = (result: WebsiteCommandRunResult) => {
      if (timedOut && !killEscalated) {
        pendingResult = result
        return
      }
      resolveNow(result)
    }

    const killChild = (signal: NodeJS.Signals) => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal)
          return
        } catch (err) {
          if (err instanceof Error && 'code' in err && err.code === 'ESRCH') return
        }
      }
      child.kill(signal)
    }

    const timeout = setTimeout(() => {
      timedOut = true
      killChild('SIGTERM')
      killTimeout = setTimeout(() => {
        killEscalated = true
        killChild('SIGKILL')
        if (pendingResult) resolveNow(pendingResult)
      }, 1_000)
    }, input.timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      const next = stdout + chunk
      stdoutTruncated = stdoutTruncated || next.length > COMMAND_OUTPUT_CAP
      stdout = clip(next, COMMAND_OUTPUT_CAP)
    })
    child.stderr?.on('data', (chunk: string) => {
      const next = stderr + chunk
      stderrTruncated = stderrTruncated || next.length > COMMAND_OUTPUT_CAP
      stderr = clip(next, COMMAND_OUTPUT_CAP)
    })
    child.on('error', (err) => {
      const nextStderr = `${stderr}${stderr ? '\n' : ''}${err.message}`
      resolveAfterCleanup({
        exitCode: null,
        stdout: clip(stdout, COMMAND_OUTPUT_CAP),
        stderr: clip(nextStderr, COMMAND_OUTPUT_CAP),
        timedOut,
        stdoutTruncated,
        stderrTruncated: stderrTruncated || nextStderr.length > COMMAND_OUTPUT_CAP,
      })
    })
    child.on('close', (code) => {
      resolveAfterCleanup({
        exitCode: code,
        stdout: clip(stdout, COMMAND_OUTPUT_CAP),
        stderr: clip(stderr, COMMAND_OUTPUT_CAP),
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      })
    })
  })
}

function parsePorcelainFiles(stdout: string): string[] {
  const files: string[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const rawFile = line.slice(3).trim()
    const file = rawFile.includes(' -> ') ? rawFile.split(' -> ').at(-1)?.trim() : rawFile
    if (file) files.push(file)
  }
  return files
}

function parsePorcelainPublishPaths(stdout: string): string[] {
  const files: string[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const rawFile = line.slice(3).trim()
    if (rawFile.includes(' -> ')) {
      for (const file of rawFile.split(' -> ').map((value) => value.trim())) {
        if (file && !files.includes(file)) files.push(file)
      }
      continue
    }
    if (rawFile && !files.includes(rawFile)) files.push(rawFile)
  }
  return files
}

interface StagedNameStatusInspection {
  files: string[]
  unsupportedFiles: string[]
  unsupportedEntries: string[]
}

function parseStagedNameStatus(stdout: string): StagedNameStatusInspection {
  const files: string[] = []
  const unsupportedFiles: string[] = []
  const unsupportedEntries: string[] = []

  const addFile = (file: string, target = files) => {
    const trimmed = file.trim()
    if (trimmed && !target.includes(trimmed)) target.push(trimmed)
  }

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue

    const parts = line.split('\t')
    const status = parts[0] ?? ''
    const changeType = status.charAt(0)

    if ((changeType === 'R' || changeType === 'C') && parts.length >= 3) {
      addFile(parts[1])
      addFile(parts[2])
      continue
    }

    if ((changeType === 'A' || changeType === 'D' || changeType === 'M') && parts.length >= 2) {
      addFile(parts[1])
      continue
    }

    unsupportedEntries.push(line)
    for (const file of parts.slice(1)) {
      addFile(file, unsupportedFiles)
      addFile(file)
    }
  }

  return { files, unsupportedFiles, unsupportedEntries }
}

function uniqueStrings(values: string[]): string[] {
  const unique: string[] = []
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value)
  }
  return unique
}

function publishStageSpecs(changedFiles: string[]): string[] {
  const specs: string[] = []
  for (const file of changedFiles) {
    let spec: string | null = null
    if (file.startsWith('src/content/')) {
      spec = 'src/content'
    } else if (file.startsWith('src/')) {
      spec = 'src'
    } else if (file.startsWith('public/images/')) {
      spec = 'public/images'
    } else if (file.startsWith('public/')) {
      spec = 'public'
    }
    if (spec && !specs.includes(spec)) specs.push(spec)
  }
  return specs
}

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    HOME: process.env.HOME,
    USER: process.env.USER,
    LANG: process.env.LANG ?? 'C.UTF-8',
  }
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return value.slice(value.length - maxChars)
}

function commandSummary(result: WebsiteCommandRunResult) {
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
    stderr: result.stderr,
  }
}

function commandFailed(result: WebsiteCommandRunResult): boolean {
  return result.timedOut || result.exitCode !== 0
}

function truncatedMachineOutput(command: string, result: WebsiteCommandRunResult, extra: Record<string, unknown> = {}) {
  return jsonResult({
    ok: false,
    code: 'git_output_truncated',
    error: `safety-critical git ${command} output was truncated`,
    ...extra,
    command: {
      exitCode: result.exitCode,
      stdout: clip(result.stdout, COMMAND_OUTPUT_CAP),
      stderr: clip(result.stderr, COMMAND_OUTPUT_CAP),
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated === true,
      stderrTruncated: result.stderrTruncated === true,
    },
  })
}

function failedCommand(
  code: string,
  error: string,
  result: WebsiteCommandRunResult,
  extra: Record<string, unknown> = {},
) {
  return jsonResult({
    ok: false,
    code,
    error,
    ...extra,
    command: {
      exitCode: result.exitCode,
      stdout: clip(result.stdout, COMMAND_OUTPUT_CAP),
      stderr: clip(result.stderr, COMMAND_OUTPUT_CAP),
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated === true,
      stderrTruncated: result.stderrTruncated === true,
    },
  })
}

function jsonResult(payload: unknown) {
  const parsed = payload as { ok?: boolean; code?: string; error?: string }
  return {
    content: JSON.stringify(payload),
    outcome: {
      ok: parsed.ok === true,
      ...(parsed.code ? { code: parsed.code } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
    },
  }
}

export function safeWebsiteRelativePath(file: string): string | null {
  const trimmed = file.trim()
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\\')) return null
  if (trimmed.split('/').some((segment) => segment === '..' || segment.startsWith('.'))) return null

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
  return isAllowedWebsitePath(normalized)
}

export function isAllowedWebsiteWritePath(file: string): boolean {
  const normalized = safeWebsiteRelativePath(file)
  if (!normalized) return false
  return isAllowedWebsitePath(normalized)
}

function isAllowedWebsitePath(file: string): boolean {
  const ext = extname(file).toLowerCase()
  const isEditableTree = file.startsWith('src/') || file.startsWith('public/')
  return isEditableTree && (
    WEBSITE_TEXT_EXTENSIONS.has(ext) ||
    WEBSITE_BINARY_EXTENSIONS.has(ext)
  )
}
