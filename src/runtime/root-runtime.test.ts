import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const readProjectFile = (relativePath: string): string =>
  readFileSync(resolve(projectRoot, relativePath), 'utf8')
const projectFileExists = (relativePath: string): boolean => existsSync(resolve(projectRoot, relativePath))
const assertIncludes = (content: string, needle: string, message?: string): void => {
  assert.ok(content.includes(needle), message ?? `expected file to include ${needle}`)
}
const assertExcludes = (content: string, needle: string, message?: string): void => {
  assert.ok(!content.includes(needle), message ?? `expected file not to include ${needle}`)
}

describe('Phase 0 root runtime contract', () => {
  test('agent:main is the only root and qq_group is only a scene identity', () => {
    assert.ok(projectFileExists('src/runtime/agent-runtime-types.ts'), 'missing src/runtime/agent-runtime-types.ts')
    const contracts = readProjectFile('src/runtime/agent-runtime-types.ts')
    const rootRuntime = projectFileExists('src/runtime/root-runtime.ts') ? readProjectFile('src/runtime/root-runtime.ts') : ''
    const legacyTypes = projectFileExists('src/runtime/types.ts') ? readProjectFile('src/runtime/types.ts') : ''

    assertIncludes(contracts, 'MAIN_AGENT_ID')
    assertIncludes(contracts, 'agent:main')
    assertIncludes(contracts, 'Scene')
    assertIncludes(contracts, 'qq_group')

    assertExcludes(`${contracts}
${rootRuntime}
${legacyTypes}`, 'makeGroupRuntimeKey', 'qq_group:* must not be constructible as a root runtime key')
    assertExcludes(`${contracts}
${rootRuntime}
${legacyTypes}`, 'runtimeKey: `qq_group:', 'qq_group:* must not be stored as root runtimeKey')
    assertExcludes(`${contracts}
${rootRuntime}`, 'groupId:', 'root runtime snapshot must not carry groupId')
  })

  test('memory is represented only as dormant contract in Phase 0', () => {
    const schema = readProjectFile('prisma/schema.prisma')
    const allRuntime = ['src/runtime/agent-runtime-types.ts', 'src/runtime/root-runtime.ts', 'src/responder/reply-generator.ts', 'src/agent/tools.ts', 'src/database/agent-sql.ts']
      .filter(projectFileExists)
      .map(readProjectFile)
      .join('\n')

    assertIncludes(schema, 'model MemoryItem')
    assertExcludes(allRuntime, 'write_memory', 'Phase 0 must not register a write_memory action')
    assertExcludes(allRuntime, 'memoryItems', 'Phase 0 generation/SQL/runtime must not read MemoryItem rows')
    assertExcludes(allRuntime, 'MemoryItem', 'MemoryItem must remain dormant outside schema/type declarations')
  })
})
