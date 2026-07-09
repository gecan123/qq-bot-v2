import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
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

const CONTENT_WRITE_EXTENSIONS = new Set(['.md', '.mdx', '.json', '.txt'])
const IMAGE_WRITE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg'])
const TEXT_READ_EXTENSIONS = new Set(['.md', '.mdx', '.json', '.txt', '.css', '.astro'])

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
      '支持 status 查看仓库状态, read 读取允许路径, write 写入允许路径.',
      '路径限制在内容、少量样式、about 页面和 public/images 下的安全文件; 不要读写配置、脚本、隐藏文件或路径逃逸.',
      'publish 当前未实现, 调用会返回 not_implemented.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = rawArgs as Args
      if (args.action === 'status') return status(runtime)
      if (args.action === 'read') return readWebsiteFile(runtime, args)
      if (args.action === 'write') return writeWebsiteFile(runtime, args)
      return jsonResult({ ok: false, code: 'not_implemented', error: 'publish is not implemented in this task' })
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
  if (relativePath && !TEXT_READ_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
    return jsonResult({ ok: false, code: 'binary_read_not_supported', file: relativePath })
  }

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

  const maxChars = args.maxChars ?? DEFAULT_READ_MAX_CHARS
  const content = await readFile(fileTarget.path, 'utf8')
  const truncated = content.length > maxChars
  return jsonResult({
    ok: true,
    file: relativePath,
    content: truncated ? content.slice(0, maxChars) : content,
    truncated,
    chars: Math.min(content.length, maxChars),
    totalChars: content.length,
  })
}

async function writeWebsiteFile(runtime: WebsiteRuntimeConfig, args: Extract<Args, { action: 'write' }>) {
  if (!isAllowedWebsiteWritePath(args.file)) {
    return jsonResult({ ok: false, code: 'path_not_allowed', file: args.file })
  }

  const relativePath = safeWebsiteRelativePath(args.file)
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

  await writeFile(absolutePath, bytes)
  return jsonResult({ ok: true, file: relativePath, bytes: bytes.byteLength })
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

export function runWebsiteCommand(input: WebsiteCommandRunInput): Promise<WebsiteCommandRunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: minimalEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      resolvePromise({
        exitCode: null,
        stdout: clip(stdout, COMMAND_OUTPUT_CAP),
        stderr: clip(stderr, COMMAND_OUTPUT_CAP),
        timedOut: true,
      })
    }, input.timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = clip(stdout + chunk, COMMAND_OUTPUT_CAP)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = clip(stderr + chunk, COMMAND_OUTPUT_CAP)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise({
        exitCode: null,
        stdout: clip(stdout, COMMAND_OUTPUT_CAP),
        stderr: clip(`${stderr}${stderr ? '\n' : ''}${err.message}`, COMMAND_OUTPUT_CAP),
        timedOut: false,
      })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise({
        exitCode: code,
        stdout: clip(stdout, COMMAND_OUTPUT_CAP),
        stderr: clip(stderr, COMMAND_OUTPUT_CAP),
        timedOut: false,
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
    stderr: result.stderr,
  }
}

function commandFailed(result: WebsiteCommandRunResult): boolean {
  return result.timedOut || result.exitCode !== 0
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
  if (file.startsWith('src/content/')) return CONTENT_WRITE_EXTENSIONS.has(ext)
  if (file === 'src/pages/about.astro') return ext === '.astro'
  if (file === 'src/styles/tokens.css') return ext === '.css'
  if (file === 'src/styles/components.css') return ext === '.css'
  if (file.startsWith('public/images/')) return IMAGE_WRITE_EXTENSIONS.has(ext)
  return false
}
