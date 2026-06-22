import 'dotenv/config'
import { existsSync, readFileSync } from 'node:fs'
import { runAgentDoctor, type DoctorFiles } from '../src/ops/agent-doctor.js'

const paths = [
  'AGENTS.md',
  'CLAUDE.md',
  'package.json',
  'prisma/schema.prisma',
  '.env.example',
  'src/index.ts',
  'src/agent/tools/index.ts',
] as const

const files: DoctorFiles = {}
for (const path of paths) {
  files[path] = existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

const result = runAgentDoctor({ files, env: process.env })

console.log(JSON.stringify(result, null, 2))

if (!result.ok) {
  process.exit(1)
}
