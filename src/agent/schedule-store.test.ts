import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { SCHEDULE_LIMITS } from './schedule-model.js'
import {
  createInMemoryScheduleStore,
  createPersistentScheduleStore,
  type ScheduleJob,
} from './schedule-store.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qq-bot-schedules-'))
  tempDirs.push(dir)
  return join(dir, 'nested', 'schedules.json')
}

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: 'schedule-1',
    name: 'review-progress',
    intention: 'Review the latest goal and decide the next useful action',
    schedule: { kind: 'at', at: '2026-07-14T01:30:00.000Z' },
    createdAt: '2026-07-14T01:00:00.000Z',
    expiresAt: '2026-07-17T01:00:00.000Z',
    nextRunAt: '2026-07-14T01:30:00.000Z',
    runCount: 0,
    ...overrides,
  }
}

function writeRaw(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value), 'utf8')
}

function tempFiles(path: string): string[] {
  if (!existsSync(dirname(path))) return []
  const prefix = `.${basename(path)}.`
  return readdirSync(dirname(path)).filter(
    (entry) => entry.startsWith(prefix) && entry.endsWith('.tmp'),
  )
}

describe('persistent schedule store', () => {
  test('returns an empty list when the state file does not exist', async () => {
    const store = createPersistentScheduleStore(tempStatePath())

    assert.deepEqual(await store.load(), [])
  })

  test('round-trips valid jobs using the version 1 disk envelope', async () => {
    const path = tempStatePath()
    const store = createPersistentScheduleStore(path)
    const schedules = [
      job(),
      job({
        id: 'schedule-2',
        name: 'periodic-review',
        schedule: {
          kind: 'every',
          everySeconds: 600,
          anchorAt: '2026-07-14T01:10:00.000+00:00',
        },
        nextRunAt: '2026-07-14T01:10:00.000Z',
        lastRunAt: '2026-07-14T01:05:00.000Z',
        runCount: 2,
        maxRuns: 5,
      }),
      job({
        id: 'schedule-3',
        name: 'cron-review',
        schedule: {
          kind: 'cron',
          expression: '0 */6 * * *',
          timezone: 'Asia/Shanghai',
        },
      }),
    ]

    await store.replace(schedules)

    assert.deepEqual(await store.load(), schedules)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      version: 1,
      schedules,
    })
    assert.deepEqual(tempFiles(path), [])
  })

  test('creates parent directories and leaves no temporary file after replacement', async () => {
    const path = tempStatePath()
    const store = createPersistentScheduleStore(path)

    await store.replace([job()])

    assert.equal(existsSync(path), true)
    assert.deepEqual(tempFiles(path), [])
  })

  test('rejects malformed JSON instead of treating it as empty state', async () => {
    const path = tempStatePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{not-json', 'utf8')

    await assert.rejects(createPersistentScheduleStore(path).load())
  })

  test('rejects unknown versions, unknown fields, and invalid schedule unions', async () => {
    const path = tempStatePath()
    const invalidStates = [
      { version: 2, schedules: [] },
      { version: 1, schedules: [], extra: true },
      { version: 1, schedules: [{ ...job(), extra: true }] },
      {
        version: 1,
        schedules: [
          job({
            schedule: {
              kind: 'at',
              at: '2026-07-14T01:30:00.000Z',
              extra: true,
            } as never,
          }),
        ],
      },
      { version: 1, schedules: [job({ schedule: { kind: 'unknown' } as never })] },
    ]

    for (const state of invalidStates) {
      writeRaw(path, state)
      await assert.rejects(createPersistentScheduleStore(path).load())
    }
  })

  test('rejects impossible timestamps and broken basic time invariants', async () => {
    const path = tempStatePath()
    const invalidJobs = [
      job({ createdAt: '2026-02-30T01:00:00.000Z' }),
      job({ expiresAt: 'not-a-date' }),
      job({ nextRunAt: '2026-07-14T02:00:00' }),
      job({ schedule: { kind: 'at', at: '2026-13-01T00:00:00.000Z' } }),
      job({ createdAt: '2026-07-17T01:00:00.000Z' }),
      job({ nextRunAt: '2026-07-18T01:00:00.000Z' }),
      job({ lastRunAt: '2026-07-13T23:00:00.000Z' }),
      job({ lastRunAt: '2026-07-14T02:00:00.000Z' }),
      job({ runCount: -1 }),
      job({ runCount: 1.5 }),
      job({ maxRuns: 0 }),
      job({ maxRuns: 1.5 }),
    ]

    for (const invalidJob of invalidJobs) {
      writeRaw(path, { version: 1, schedules: [invalidJob] })
      await assert.rejects(createPersistentScheduleStore(path).load())
    }
  })

  test('rejects stored every schedules outside the recurrence model limits', async () => {
    const path = tempStatePath()
    const invalidSchedules: ScheduleJob['schedule'][] = [
      {
        kind: 'every',
        everySeconds: SCHEDULE_LIMITS.minRecurringIntervalMs / 1_000 - 1,
        anchorAt: '2026-07-14T01:00:00.000Z',
      },
      {
        kind: 'every',
        everySeconds: Number.MAX_VALUE,
        anchorAt: '2026-07-14T01:00:00.000Z',
      },
    ]

    for (const schedule of invalidSchedules) {
      writeRaw(path, { version: 1, schedules: [job({ schedule })] })
      await assert.rejects(createPersistentScheduleStore(path).load())
    }
  })

  test('rejects stored cron expressions and timezones that the schedule model cannot evaluate', async () => {
    const path = tempStatePath()
    const invalidSchedules: ScheduleJob['schedule'][] = [
      { kind: 'cron', expression: 'not a cron', timezone: 'Asia/Shanghai' },
      { kind: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' },
    ]

    for (const schedule of invalidSchedules) {
      writeRaw(path, { version: 1, schedules: [job({ schedule })] })
      await assert.rejects(createPersistentScheduleStore(path).load())
    }
  })

  test('validates stored at schedules against their original creation time', async () => {
    const path = tempStatePath()
    const invalidJobs = [
      job({
        schedule: { kind: 'at', at: '2026-07-14T01:00:29.000Z' },
        nextRunAt: '2026-07-14T01:00:29.000Z',
      }),
      job({
        schedule: { kind: 'at', at: '2026-07-17T01:00:00.001Z' },
        expiresAt: '2026-07-18T01:00:00.000Z',
        nextRunAt: '2026-07-17T01:00:00.001Z',
      }),
    ]

    for (const invalidJob of invalidJobs) {
      writeRaw(path, { version: 1, schedules: [invalidJob] })
      await assert.rejects(createPersistentScheduleStore(path).load())
    }
  })

  test('rejects state containing more than the active schedule limit', async () => {
    const path = tempStatePath()
    const schedules = Array.from(
      { length: SCHEDULE_LIMITS.maxActiveSchedules + 1 },
      (_, index) => job({ id: `schedule-${index}`, name: `schedule-${index}` }),
    )
    writeRaw(path, { version: 1, schedules })

    await assert.rejects(createPersistentScheduleStore(path).load())
  })

  test('preserves the previous file when a replacement cannot be written', async () => {
    const path = tempStatePath()
    const store = createPersistentScheduleStore(path)
    const original = [job()]
    await store.replace(original)
    chmodSync(dirname(path), 0o500)

    try {
      await assert.rejects(store.replace([job({ name: 'must-not-replace-original' })]))
    } finally {
      chmodSync(dirname(path), 0o700)
    }

    assert.deepEqual(await store.load(), original)
    assert.deepEqual(tempFiles(path), [])
  })

  test('uses independent temporary files for concurrent replacements', async () => {
    const path = tempStatePath()
    const store = createPersistentScheduleStore(path)
    const first = [job({ name: 'first-write' })]
    const second = [job({ name: 'second-write' })]

    await Promise.all([store.replace(first), store.replace(second)])

    const stored = await store.load()
    assert.equal(
      JSON.stringify(stored) === JSON.stringify(first) ||
        JSON.stringify(stored) === JSON.stringify(second),
      true,
    )
    assert.deepEqual(tempFiles(path), [])
  })
})

describe('in-memory schedule store', () => {
  test('implements the same replacement contract without exposing mutable state', async () => {
    const input = [job()]
    const store = createInMemoryScheduleStore()

    await store.replace(input)
    input[0]!.name = 'mutated-input'
    ;(input[0]!.schedule as Extract<ScheduleJob['schedule'], { kind: 'at' }>).at =
      '2026-07-14T02:00:00.000Z'

    const firstLoad = await store.load()
    assert.equal(firstLoad[0]!.name, 'review-progress')
    assert.equal(firstLoad[0]!.schedule.kind, 'at')
    firstLoad[0]!.intention = 'mutated-output'

    const secondLoad = await store.load()
    assert.equal(secondLoad[0]!.intention, 'Review the latest goal and decide the next useful action')
  })

  test('deep-clones initial state and applies the same validation as the file store', async () => {
    const initial = [job()]
    const store = createInMemoryScheduleStore(initial)
    initial[0]!.name = 'mutated-after-construction'

    assert.equal((await store.load())[0]!.name, 'review-progress')
    await assert.rejects(store.replace([job({ runCount: -1 })]))
  })
})
