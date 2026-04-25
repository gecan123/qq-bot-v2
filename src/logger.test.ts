import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, test } from 'node:test'

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(import.meta.dirname, '..')

describe('logger', () => {
  test('prints scope prefix and small objects on a single line in pretty output', async () => {
    const script = `
      import { createLogger } from './src/logger.ts'
      const log = createLogger('INGRESS')

      void (async () => {
        log.info(
          { group: 476109921, sender: '堂吉诃德', segments: 1, mediaReferences: 1 },
          '[image]',
        )

        await new Promise((resolve) => setTimeout(resolve, 100))
      })()
    `

    const { stdout, stderr } = await execFileAsync(
      'pnpm',
      ['exec', 'tsx', '--eval', script],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          LOG_FILE_ENABLED: 'false',
        },
      },
    )

    assert.equal(stderr, '')

    const lines = stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)

    assert.equal(lines.length, 1)
    assert.match(
      lines[0] ?? '',
      /\[INGRESS\] \[image\].*"group":476109921.*"sender":"堂吉诃德".*"segments":1.*"mediaReferences":1/,
    )
  })
})
