import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BrowserController,
  buildCloakLaunchOptions,
  pruneBrowserArtifacts,
  scheduleBrowserArtifactPrune,
} from './controller.js'
import { createTaskScheduler } from '../agent/task-scheduler.js'

const RUN_REAL_BROWSER = process.env.BOT_BROWSER_REAL_TESTS === '1'

describe('buildCloakLaunchOptions', () => {
  it('maps controller config to CloakBrowser persistent-context options', () => {
    assert.deepEqual(
      buildCloakLaunchOptions({
        profileDir: 'data/browser-profile/luna',
        artifactDir: 'data/agent-workspace/browser',
        actionLogPath: 'logs/browser-actions.ndjson',
        actionTimeoutMs: 15_000,
        headless: true,
        humanize: false,
        humanPreset: 'careful',
        proxy: 'http://user:pass@proxy.example:8080',
        geoip: true,
        timezone: 'America/New_York',
        locale: 'en-US',
        extensionPaths: ['data/browser-extensions/one'],
        args: ['--fingerprint=12345'],
      }),
      {
        userDataDir: 'data/browser-profile/luna',
        headless: true,
        humanize: false,
        humanPreset: 'careful',
        proxy: 'http://user:pass@proxy.example:8080',
        geoip: true,
        timezone: 'America/New_York',
        locale: 'en-US',
        extensionPaths: ['data/browser-extensions/one'],
        args: ['--fingerprint=12345'],
      },
    )
  })
})

describe('pruneBrowserArtifacts', () => {
  it('removes artifacts by age and count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-artifacts-'))
    try {
      await mkdir(join(root, 'screenshots'), { recursive: true })
      await writeFile(join(root, 'keep.txt'), 'not controller owned')
      for (const name of ['a.png', 'b.png', 'old.png']) {
        await writeFile(join(root, 'screenshots', name), name)
      }
      const old = new Date('2026-06-01T00:00:00.000Z')
      await utimes(join(root, 'screenshots', 'old.png'), old, old)

      const result = await pruneBrowserArtifacts(root, {
        maxFiles: 1,
        maxAgeMs: 14 * 24 * 60 * 60 * 1000,
        now: () => new Date('2026-07-11T00:00:00.000Z'),
      })
      assert.equal(result.removed.length, 2)
      assert.equal((await readdir(join(root, 'screenshots'))).length, 1)
      assert.equal(await readdir(root).then((entries) => entries.includes('keep.txt')), true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('scheduleBrowserArtifactPrune', () => {
  it('coalesces repeated housekeeping triggers and runs them off the action path', async () => {
    const scheduler = createTaskScheduler({ housekeeping: { concurrency: 1 } })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const task = async () => {
      calls++
      await gate
    }

    scheduleBrowserArtifactPrune(scheduler, '/tmp/browser-artifacts', task)
    scheduleBrowserArtifactPrune(scheduler, '/tmp/browser-artifacts', task)
    assert.equal(calls, 1)

    release()
    await scheduler.drain()
    assert.equal(calls, 1)
  })
})

describe('BrowserController real browser fixture', { skip: !RUN_REAL_BROWSER }, () => {
  let fixtureServer: Server
  let fixtureUrl: string
  let tmp: string
  let controller: BrowserController

  before(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'qq-bot-browser-'))
    fixtureServer = createServer((req, res) => {
      if (req.url === '/download.txt') {
        res.setHeader('content-type', 'text/plain')
        res.end('download fixture')
        return
      }
      if (req.url === '/installer.dmg') {
        res.setHeader('content-type', 'application/octet-stream')
        res.end('fake dmg')
        return
      }
      res.setHeader('content-type', 'text/html')
      res.end(`<!doctype html>
        <title>Browser Tool Fixture</title>
        <button>I am human</button>
        <input placeholder="Write comment">
        <button>Post comment</button>
        <button>Pay now</button>
        <a href="/download.txt" download="download.txt">Download text file</a>
        <a href="/installer.dmg" download="installer.dmg">Download .dmg</a>`)
    })
    await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve))
    const address = fixtureServer.address()
    assert.ok(address && typeof address === 'object')
    fixtureUrl = `http://127.0.0.1:${address.port}/`
    controller = new BrowserController({
      profileDir: join(tmp, 'profile'),
      artifactDir: join(tmp, 'artifacts'),
      actionLogPath: join(tmp, 'browser-actions.ndjson'),
      actionTimeoutMs: 15_000,
      headless: process.env.BOT_BROWSER_HEADED_TESTS === '1' ? false : true,
    })
  })

  after(async () => {
    await controller?.close()
    await new Promise<void>((resolve) => fixtureServer.close(() => resolve()))
    await rm(tmp, { recursive: true, force: true })
  })

  it('runs open -> observe -> click -> type -> screenshot -> download on a real browser', async () => {
    const opened = await controller.execute({ action: 'open', url: fixtureUrl })
    assert.equal(opened.ok, true)
    assert.ok(opened.pageId)

    const observed = await controller.execute({ action: 'observe', pageId: opened.pageId })
    assert.equal(observed.ok, true)
    assert.ok(observed.elements?.some((el) => el.label === 'Post comment'))

    const comment = observed.elements?.find((el) => el.label === 'Write comment')
    assert.ok(comment)
    const typed = await controller.execute({ action: 'type', pageId: opened.pageId, elementId: comment.elementId, text: 'hello', clear: true })
    assert.equal(typed.ok, true)

    const post = observed.elements?.find((el) => el.label === 'Post comment')
    assert.ok(post)
    const clicked = await controller.execute({ action: 'click', pageId: opened.pageId, elementId: post.elementId })
    assert.equal(clicked.ok, true)
    assert.equal(clicked.risk, 'normal')

    const shot = await controller.execute({ action: 'screenshot', pageId: opened.pageId })
    assert.equal(shot.ok, true)
    assert.ok(shot.image?.source.data)
    assert.ok(shot.artifactPath)

    const fresh = await controller.execute({ action: 'observe', pageId: opened.pageId })
    const download = fresh.elements?.find((el) => el.label === 'Download text file')
    assert.ok(download)
    const downloaded = await controller.execute({ action: 'download', pageId: opened.pageId, elementId: download.elementId })
    assert.equal(downloaded.ok, true)
    assert.ok(downloaded.artifactPath)
  })

  it('blocks high-risk click and download actions', async () => {
    const opened = await controller.execute({ action: 'open', url: fixtureUrl, newPage: true })
    assert.equal(opened.ok, true)
    const observed = await controller.execute({ action: 'observe', pageId: opened.pageId })
    const pay = observed.elements?.find((el) => el.label === 'Pay now')
    assert.ok(pay)
    const blockedPay = await controller.execute({ action: 'click', pageId: opened.pageId, elementId: pay.elementId })
    assert.equal(blockedPay.ok, false)
    assert.equal(blockedPay.requiresOwnerHelp, true)

    const dmg = observed.elements?.find((el) => el.label === 'Download .dmg')
    assert.ok(dmg)
    const blockedDownload = await controller.execute({ action: 'download', pageId: opened.pageId, elementId: dmg.elementId })
    assert.equal(blockedDownload.ok, false)
    assert.equal(blockedDownload.requiresOwnerHelp, true)
  })
})
