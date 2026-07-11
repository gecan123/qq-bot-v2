import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserContext, Page } from 'playwright-core'
import { launchPersistentContext } from 'cloakbrowser'
import type { LaunchPersistentContextOptions } from 'cloakbrowser'
import { compressForContext } from '../media/compress-for-context.js'
import {
  BROWSER_OBSERVE_ELEMENT_LIMIT,
  type BrowserActionInput,
  type BrowserActionJsonResult,
  type BrowserControllerConfig,
  type BrowserElementSummary,
  type BrowserPageSummary,
  browserActionInputSchema,
  clampBrowserLabel,
} from './protocol.js'
import { buildBrowserActionLogEntry, logBrowserAction } from './action-log.js'
import { classifyBrowserActionRisk, classifyDownload } from './risk.js'
import { createLogger } from '../logger.js'

const log = createLogger('BROWSER_CONTROLLER')
const ELEMENT_ATTR = 'data-luna-browser-element-id'
const DEFAULT_ARTIFACT_MAX_FILES = 50
const DEFAULT_ARTIFACT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[contenteditable="true"]',
  'summary',
].join(',')

export function buildCloakLaunchOptions(config: BrowserControllerConfig): LaunchPersistentContextOptions {
  return {
    userDataDir: config.profileDir,
    headless: config.headless ?? false,
    humanize: config.humanize ?? true,
    ...(config.humanPreset ? { humanPreset: config.humanPreset } : {}),
    ...(config.proxy ? { proxy: config.proxy } : {}),
    ...(config.geoip != null ? { geoip: config.geoip } : {}),
    ...(config.timezone ? { timezone: config.timezone } : {}),
    ...(config.locale ? { locale: config.locale } : {}),
    ...(config.extensionPaths?.length ? { extensionPaths: config.extensionPaths } : {}),
    ...(config.args?.length ? { args: config.args } : {}),
  }
}

interface PageRecord {
  pageId: string
  page: Page
  active: boolean
  lastUsedAt: Date
  loadState: BrowserPageSummary['loadState']
  elements: Map<string, BrowserElementSummary>
}

export class BrowserController {
  private context: BrowserContext | null = null
  private pages = new Map<string, PageRecord>()
  private activePageId: string | null = null
  private crashed = false

  constructor(private readonly config: BrowserControllerConfig) {}

  async execute(rawInput: unknown): Promise<BrowserActionJsonResult> {
    const parsed = browserActionInputSchema.safeParse(rawInput)
    if (!parsed.success) {
      return {
        ok: false,
        action: 'status',
        code: 'invalid_browser_action_args',
        error: JSON.stringify(parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))),
      }
    }

    const input = parsed.data
    const startedAt = Date.now()
    let result: BrowserActionJsonResult
    try {
      result = await this.executeParsed(input)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = normalizeBrowserErrorCode(message)
      result = {
        ok: false,
        action: input.action,
        code,
        error: message,
      }
    }

    await logBrowserAction(
      buildBrowserActionLogEntry({ startedAt, action: input, result }),
      { path: this.config.actionLogPath },
    )
    return result
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {})
    this.context = null
    this.pages.clear()
    this.activePageId = null
  }

  private async executeParsed(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    switch (input.action) {
      case 'help':
        return this.help()
      case 'status':
        return this.status()
      case 'open':
        return this.open(input)
      case 'switch_page':
        return this.switchPage(input)
      case 'close_page':
        return this.closePage(input)
      case 'observe':
        return this.observe(input)
      case 'click':
        return this.click(input)
      case 'type':
        return this.type(input)
      case 'press':
        return this.press(input)
      case 'scroll':
        return this.scroll(input)
      case 'screenshot':
        return this.screenshot(input)
      case 'download':
        return this.download(input)
      case 'annotate':
        return this.annotate(input)
      case 'request_owner_help':
        return this.requestOwnerHelp(input)
    }
  }

  private help(): BrowserActionJsonResult {
    return {
      ok: true,
      action: 'help',
      message: [
        'browser 是单步真实浏览器工具. 一次只做一个 action.',
        '底层是 headed CloakBrowser persistent profile, 登录态和 cookie 可跨 sidecar 重启复用.',
        '常用流程: open -> observe -> click/type/scroll -> screenshot/download/annotate.',
        'observe 返回可交互 elementId; click/type 优先传 elementId. 坐标点击只作为 fallback.',
        'screenshot 会把压缩图作为 image block 返回并进入 AgentContext.',
        '遇到登录/2FA/支付/账号安全/OAuth/可执行下载等高风险状态, 调 request_owner_help.',
        '普通 Cloudflare/Turnstile/cookie consent/我是人类按钮应先自主处理.',
      ].join('\n'),
    }
  }

  private async status(): Promise<BrowserActionJsonResult> {
    return {
      ok: true,
      action: 'status',
      message: this.context ? (this.crashed ? 'browser crashed' : 'browser ready') : 'browser not started',
      activePageId: this.activePageId ?? undefined,
      pages: await this.summarizePages(),
    }
  }

  private async open(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    if (!input.url) return this.fail(input.action, 'missing_url', 'open requires url')
    const url = new URL(input.url)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return this.fail(input.action, 'unsupported_url_protocol', 'only http/https URLs are allowed')
    }

    const context = await this.ensureContext()
    const record = input.newPage || this.pages.size === 0
      ? await this.createPageRecord(await context.newPage())
      : await this.getPageRecord(input.pageId)
    await record.page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: this.config.actionTimeoutMs })
    this.setActive(record.pageId)
    return {
      ok: true,
      action: 'open',
      pageId: record.pageId,
      url: record.page.url(),
      title: await safeTitle(record.page),
      activePageId: this.activePageId ?? undefined,
      pages: await this.summarizePages(),
    }
  }

  private async switchPage(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    if (!input.pageId) return this.fail(input.action, 'missing_page_id', 'switch_page requires pageId')
    const record = await this.getPageRecord(input.pageId)
    this.setActive(record.pageId)
    await record.page.bringToFront().catch(() => {})
    return {
      ok: true,
      action: 'switch_page',
      pageId: record.pageId,
      url: record.page.url(),
      title: await safeTitle(record.page),
      activePageId: record.pageId,
      pages: await this.summarizePages(),
    }
  }

  private async closePage(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    const record = await this.getPageRecord(input.pageId)
    await record.page.close().catch(() => {})
    this.pages.delete(record.pageId)
    if (this.activePageId === record.pageId) {
      this.activePageId = this.pages.keys().next().value ?? null
      this.markActiveFlags()
    }
    return { ok: true, action: 'close_page', activePageId: this.activePageId ?? undefined, pages: await this.summarizePages() }
  }

  private async observe(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    const record = await this.getPageRecord(input.pageId)
    const page = record.page
    const title = await safeTitle(page)
    const elements = await collectElements(page)
    record.elements = new Map(elements.map((el) => [el.elementId, el]))
    record.lastUsedAt = new Date()
    return {
      ok: true,
      action: 'observe',
      pageId: record.pageId,
      url: page.url(),
      title,
      pages: await this.summarizePages(),
      elements,
    }
  }

  private async click(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    const record = await this.getPageRecord(input.pageId)
    const element = input.elementId ? record.elements.get(input.elementId) ?? null : null
    const risk = classifyBrowserActionRisk({ action: 'click', url: record.page.url(), element })
    if (risk.requiresOwnerHelp) return this.ownerHelpResult(input.action, risk.reason, record, risk.level)

    if (input.elementId) {
      await record.page.locator(`[${ELEMENT_ATTR}="${cssString(input.elementId)}"]`).first().click({ timeout: this.config.actionTimeoutMs })
    } else if (input.x != null && input.y != null) {
      await record.page.mouse.click(input.x, input.y)
    } else {
      return this.fail(input.action, 'missing_click_target', 'click requires elementId or x/y coordinates')
    }
    record.lastUsedAt = new Date()
    return {
      ok: true,
      action: 'click',
      risk: risk.level,
      reason: risk.reason,
      pageId: record.pageId,
      url: record.page.url(),
      title: await safeTitle(record.page),
      message: 'clicked',
    }
  }

  private async type(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    const record = await this.getPageRecord(input.pageId)
    const element = input.elementId ? record.elements.get(input.elementId) ?? null : null
    const risk = classifyBrowserActionRisk({ action: 'type', url: record.page.url(), element, text: input.text })
    if (risk.requiresOwnerHelp) return this.ownerHelpResult(input.action, risk.reason, record, risk.level)
    if (input.text == null) return this.fail(input.action, 'missing_text', 'type requires text')

    if (input.elementId) {
      const locator = record.page.locator(`[${ELEMENT_ATTR}="${cssString(input.elementId)}"]`).first()
      if (input.clear) await locator.fill('', { timeout: this.config.actionTimeoutMs })
      await locator.pressSequentially(input.text, { timeout: this.config.actionTimeoutMs, delay: 35 })
    } else {
      await record.page.keyboard.type(input.text, { delay: 35 })
    }
    record.lastUsedAt = new Date()
    return {
      ok: true,
      action: 'type',
      risk: risk.level,
      reason: risk.reason,
      pageId: record.pageId,
      url: record.page.url(),
      title: await safeTitle(record.page),
      message: 'typed',
    }
  }

  private async press(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    if (!input.key) return this.fail(input.action, 'missing_key', 'press requires key')
    const record = await this.getPageRecord(input.pageId)
    await record.page.keyboard.press(input.key, { delay: 30 })
    record.lastUsedAt = new Date()
    return { ok: true, action: 'press', pageId: record.pageId, url: record.page.url(), title: await safeTitle(record.page) }
  }

  private async scroll(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    const record = await this.getPageRecord(input.pageId)
    const amount = input.amount ?? 700
    const x = input.direction === 'left' ? -amount : input.direction === 'right' ? amount : 0
    const y = input.direction === 'up' ? -amount : input.direction === 'down' || !input.direction ? amount : 0
    await record.page.mouse.wheel(x, y)
    record.lastUsedAt = new Date()
    return { ok: true, action: 'scroll', pageId: record.pageId, url: record.page.url(), title: await safeTitle(record.page) }
  }

  private async screenshot(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    const record = await this.getPageRecord(input.pageId)
    const bytes = await record.page.screenshot({ fullPage: input.fullPage ?? false, type: 'png', timeout: this.config.actionTimeoutMs })
    const artifactId = `shot_${timestampId()}`
    const artifactPath = resolve(this.config.artifactDir, 'screenshots', `${artifactId}.png`)
    await mkdir(dirname(artifactPath), { recursive: true })
    await writeFile(artifactPath, bytes)
    await this.pruneArtifacts()
    const compressed = await compressForContext(Buffer.from(bytes))
    const result: BrowserActionJsonResult = {
      ok: true,
      action: 'screenshot',
      pageId: record.pageId,
      url: record.page.url(),
      title: await safeTitle(record.page),
      artifactId,
      artifactPath,
      contentType: 'image/png',
      byteSize: bytes.byteLength,
    }
    if (compressed) {
      result.image = {
        type: 'image',
        source: { type: 'base64', media_type: compressed.mediaType, data: compressed.base64 },
      }
    }
    return result
  }

  private async download(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    const record = await this.getPageRecord(input.pageId)
    const element = input.elementId ? record.elements.get(input.elementId) ?? null : null
    if (!input.elementId) return this.fail(input.action, 'missing_element_id', 'download requires elementId')

    const hrefRisk = classifyDownload(element?.href ? basename(new URL(element.href, record.page.url()).pathname) : undefined)
    if (hrefRisk.requiresOwnerHelp) return this.ownerHelpResult(input.action, hrefRisk.reason, record, hrefRisk.level)

    const [download] = await Promise.all([
      record.page.waitForEvent('download', { timeout: this.config.actionTimeoutMs }),
      record.page.locator(`[${ELEMENT_ATTR}="${cssString(input.elementId)}"]`).first().click({ timeout: this.config.actionTimeoutMs }),
    ])
    const suggested = download.suggestedFilename()
    const risk = classifyDownload(suggested)
    if (risk.requiresOwnerHelp) {
      await download.cancel().catch(() => {})
      return this.ownerHelpResult(input.action, risk.reason, record, risk.level)
    }

    const artifactId = `download_${timestampId()}`
    const safeName = safeFileName(suggested || artifactId)
    const artifactPath = resolve(this.config.artifactDir, 'downloads', `${artifactId}-${safeName}`)
    await mkdir(dirname(artifactPath), { recursive: true })
    await download.saveAs(artifactPath)
    await this.pruneArtifacts()
    return {
      ok: true,
      action: 'download',
      risk: risk.level,
      reason: risk.reason,
      pageId: record.pageId,
      url: record.page.url(),
      title: await safeTitle(record.page),
      artifactId,
      artifactPath,
      fileName: suggested,
      contentType: contentTypeFromExtension(suggested),
    }
  }

  private async annotate(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    if (!input.text) return this.fail(input.action, 'missing_text', 'annotate requires text')
    const record = await this.getPageRecord(input.pageId)
    const url = record.page.url()
    const domain = safeFileName(new URL(url).hostname || 'unknown')
    const artifactId = input.artifactId ?? `note_${timestampId()}`
    const artifactPath = resolve(this.config.artifactDir, 'annotations', domain, `${artifactId}.md`)
    const body = [`# Browser Annotation`, '', `- URL: ${url}`, `- Title: ${await safeTitle(record.page)}`, `- Time: ${new Date().toISOString()}`, '', input.text, ''].join('\n')
    await mkdir(dirname(artifactPath), { recursive: true })
    await writeFile(artifactPath, body, 'utf8')
    await this.pruneArtifacts()
    return { ok: true, action: 'annotate', pageId: record.pageId, url, title: await safeTitle(record.page), artifactId, artifactPath }
  }

  private async requestOwnerHelp(input: BrowserActionInput): Promise<BrowserActionJsonResult> {
    const record = await this.getPageRecord(input.pageId, false)
    return {
      ok: false,
      action: 'request_owner_help',
      requiresOwnerHelp: true,
      risk: 'high',
      reason: input.reason ?? 'owner help requested',
      pageId: record?.pageId,
      url: record?.page.url(),
      title: record ? await safeTitle(record.page) : undefined,
      code: 'requires_owner_help',
    }
  }

  private async pruneArtifacts(): Promise<void> {
    try {
      const result = await pruneBrowserArtifacts(this.config.artifactDir, {
        maxFiles: this.config.artifactMaxFiles ?? DEFAULT_ARTIFACT_MAX_FILES,
        maxAgeMs: this.config.artifactMaxAgeMs ?? DEFAULT_ARTIFACT_MAX_AGE_MS,
      })
      if (result.removed.length > 0) {
        log.info({ removedCount: result.removed.length, kept: result.kept }, 'browser_artifacts_pruned')
      }
    } catch (err) {
      log.warn({ err }, 'browser_artifact_prune_failed')
    }
  }

  private ownerHelpResult(
    action: BrowserActionInput['action'],
    reason: string,
    record: PageRecord,
    risk: 'low' | 'normal' | 'high',
  ): BrowserActionJsonResult {
    return {
      ok: false,
      action,
      requiresOwnerHelp: true,
      risk,
      reason,
      code: 'requires_owner_help',
      pageId: record.pageId,
      url: record.page.url(),
    }
  }

  private fail(action: BrowserActionInput['action'], code: string, error: string): BrowserActionJsonResult {
    return { ok: false, action, code, error }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context
    await mkdir(this.config.profileDir, { recursive: true })
    await mkdir(this.config.artifactDir, { recursive: true })
    this.context = await launchPersistentContext(buildCloakLaunchOptions(this.config))
    this.crashed = false
    for (const page of this.context.pages()) {
      await this.createPageRecord(page)
    }
    this.context.on('close', () => {
      this.crashed = true
      this.context = null
      this.pages.clear()
      this.activePageId = null
    })
    return this.context
  }

  private async createPageRecord(page: Page): Promise<PageRecord> {
    const pageId = `page_${this.pages.size + 1}_${randomUUID().slice(0, 8)}`
    const record: PageRecord = {
      pageId,
      page,
      active: false,
      lastUsedAt: new Date(),
      loadState: 'unknown',
      elements: new Map(),
    }
    page.on('domcontentloaded', () => { record.loadState = 'domcontentloaded' })
    page.on('load', () => { record.loadState = 'networkidle' })
    page.on('close', () => {
      this.pages.delete(pageId)
      if (this.activePageId === pageId) this.activePageId = this.pages.keys().next().value ?? null
      this.markActiveFlags()
    })
    this.pages.set(pageId, record)
    if (!this.activePageId) this.setActive(pageId)
    return record
  }

  private async getPageRecord(pageId?: string, autoStart = true): Promise<PageRecord> {
    if (autoStart) await this.ensureContext()
    const id = pageId ?? this.activePageId
    if (!id) {
      if (!autoStart) throw new Error('No active page')
      const context = await this.ensureContext()
      return this.createPageRecord(await context.newPage())
    }
    const record = this.pages.get(id)
    if (!record || record.page.isClosed()) throw new Error(`page_not_found: ${id}`)
    record.lastUsedAt = new Date()
    return record
  }

  private setActive(pageId: string): void {
    this.activePageId = pageId
    this.markActiveFlags()
  }

  private markActiveFlags(): void {
    for (const record of this.pages.values()) record.active = record.pageId === this.activePageId
  }

  private async summarizePages(): Promise<BrowserPageSummary[]> {
    const summaries: BrowserPageSummary[] = []
    for (const record of this.pages.values()) {
      const closed = record.page.isClosed()
      summaries.push({
        pageId: record.pageId,
        url: closed ? '' : record.page.url(),
        title: closed ? '' : await safeTitle(record.page),
        active: record.active,
        loadState: record.loadState,
        closed,
        lastUsedAt: record.lastUsedAt.toISOString(),
      })
    }
    return summaries
  }
}

export async function pruneBrowserArtifacts(
  artifactDir: string,
  options: { maxFiles: number; maxAgeMs: number; now?: () => Date },
): Promise<{ removed: string[]; kept: number }> {
  const files: Array<{ path: string; mtimeMs: number }> = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push({ path, mtimeMs: (await stat(path)).mtimeMs })
    }
  }
  for (const directory of ['screenshots', 'downloads', 'annotations']) {
    await visit(resolve(artifactDir, directory))
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
  const cutoff = (options.now?.() ?? new Date()).getTime() - options.maxAgeMs
  const removed: string[] = []
  for (const [index, file] of files.entries()) {
    if (index < options.maxFiles && file.mtimeMs >= cutoff) continue
    await rm(file.path, { force: true })
    removed.push(file.path)
  }
  return { removed, kept: files.length - removed.length }
}

async function collectElements(page: Page): Promise<BrowserElementSummary[]> {
  const elements = await page.evaluate<BrowserElementSummary[]>(`(() => {
    const selector = ${JSON.stringify(INTERACTIVE_SELECTOR)};
    const limit = ${BROWSER_OBSERVE_ELEMENT_LIMIT};
    const attr = ${JSON.stringify(ELEMENT_ATTR)};
    const nodes = Array.from(document.querySelectorAll(selector));
    const out = [];
    const visibleText = (el) => (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.innerText ||
      el.textContent ||
      ''
    ).replace(/\\s+/g, ' ').trim();
    const roleFor = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input' || tag === 'textarea') return 'textbox';
      return tag;
    };
    for (const [index, el] of nodes.entries()) {
      if (out.length >= limit) break;
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      if (!visible) continue;
      const elementId = 'el_' + (index + 1);
      el.setAttribute(attr, elementId);
      const item = {
        elementId,
        role: roleFor(el),
        label: visibleText(el),
        tagName: el.tagName.toLowerCase(),
        visible,
      };
      const type = el.getAttribute('type');
      if (type) item.type = type;
      const href = el.getAttribute('href');
      if (href) item.href = href;
      if ('disabled' in el && el.disabled) item.disabled = true;
      out.push(item);
    }
    return out;
  })()`)
  return elements.map((element) => ({
    ...element,
    label: clampBrowserLabel(element.label),
  }))
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return await page.title()
  } catch {
    return ''
  }
}

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160) || 'artifact'
}

function cssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function contentTypeFromExtension(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.txt':
      return 'text/plain'
    case '.json':
      return 'application/json'
    case '.csv':
      return 'text/csv'
    case '.pdf':
      return 'application/pdf'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    default:
      return 'application/octet-stream'
  }
}

function normalizeBrowserErrorCode(message: string): string {
  if (message.startsWith('page_not_found')) return 'page_not_found'
  if (/Target page, context or browser has been closed/i.test(message)) return 'browser_crashed'
  if (/Timeout|timed out/i.test(message)) return 'navigation_timeout'
  if (/strict mode violation|not attached|detached|Element is not attached|waiting for locator/i.test(message)) {
    return 'element_stale'
  }
  if (/Executable doesn't exist|Failed to launch|browserType.launchPersistentContext/i.test(message)) {
    return 'browser_start_failed'
  }
  return 'browser_action_failed'
}
