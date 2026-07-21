import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { test } from 'vitest'

const sourceRoot = join(process.cwd(), 'src')

test('Admin Web production source preserves server/client and localized mutation boundaries', () => {
  const violations: string[] = []

  for (const path of listSourceFiles(sourceRoot)) {
    const relativePath = relative(sourceRoot, path).replaceAll('\\', '/')
    const source = readFileSync(path, 'utf8')

    if (isBrowserProductionSource(relativePath)) {
      for (const marker of ['@prisma/', 'node:', '../../../../src/generated/prisma/', 'src/database/', 'process.env']) {
        if (source.includes(marker)) violations.push(`${relativePath}: ${marker}`)
      }
    }

    if (relativePath.includes('/features/') || relativePath.startsWith('features/')) {
      if (/\.(?:server|functions)\.tsx?$/.test(relativePath)) {
        const operationsServer = relativePath === 'features/operations/operations.server.ts'
        if (!operationsServer) {
          for (const mutation of ['.create(', '.createMany(', '.update(', '.updateMany(', '.upsert(', '.delete(', '.deleteMany(', '.$executeRaw(']) {
            if (source.includes(mutation)) violations.push(`${relativePath}: ${mutation}`)
          }
        } else {
          if (!source.startsWith("import '@tanstack/react-start/server-only'")) {
            violations.push(`${relativePath}: missing server-only first import`)
          }
          if (!source.includes('resetAgentState')) {
            violations.push(`${relativePath}: missing typed reset service`)
          }
          for (const commandMarker of [
            'node:child_process',
            'execFile(',
            'spawn(',
            'scripts/',
            '$executeRaw',
            '$queryRaw',
          ]) {
            if (source.includes(commandMarker)) violations.push(`${relativePath}: ${commandMarker}`)
          }
        }
      }
    }
  }

  assert.deepEqual(violations, [])
})

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return listSourceFiles(path)
      return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
    })
}

function isBrowserProductionSource(path: string): boolean {
  return !(
    /\.server\.tsx?$/.test(path)
    || /\.test\.tsx?$/.test(path)
    || path === 'routeTree.gen.ts'
  )
}
