import { resolve } from 'node:path'
import { createLlmClient } from '../src/agent/llm-client.js'
import { assertBotStopped } from '../src/ops/bot-process-guard.js'
import { migrateLongTermStateToChinese } from '../src/ops/long-term-state-language-migration.js'
import { createLongTermStateTranslator } from '../src/ops/long-term-state-language-translator.js'

const APPLY_ARG = '--apply'

async function main(): Promise<void> {
  if (!process.argv.includes(APPLY_ARG)) {
    throw new Error(`language migration changes persisted long-term state; rerun with ${APPLY_ARG}`)
  }
  const rootDir = resolve(parseRootArg(process.argv.slice(2)))
  await assertBotStopped(resolve('.'))
  const translate = createLongTermStateTranslator(createLlmClient())
  const result = await migrateLongTermStateToChinese({
    rootDir,
    translate: items => translate(items, progress => {
      process.stderr.write(
        `translating long-term state batch ${progress.completedBatches}/${progress.totalBatches}\n`,
      )
    }),
  })
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`)
}

function parseRootArg(args: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === APPLY_ARG || arg === '--') continue
    if (arg?.startsWith('--root=')) return arg.slice('--root='.length)
    if (arg === '--root') {
      const value = args[index + 1]
      if (!value) throw new Error('--root requires a path')
      return value
    }
    if (index > 0 && args[index - 1] === '--root') continue
    throw new Error(`unknown argument: ${arg}`)
  }
  return 'data/agent-workspace'
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
