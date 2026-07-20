import '@tanstack/react-start/server-only'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

let cachedRoot: string | null = null

export function getRepositoryRoot(start = process.cwd()): string {
  if (cachedRoot) return cachedRoot
  let current = resolve(start)
  while (true) {
    if (existsSync(join(current, 'prisma', 'schema.prisma')) && existsSync(join(current, 'apps', 'admin-web'))) {
      cachedRoot = current
      return current
    }
    const parent = dirname(current)
    if (parent === current) throw new Error('Unable to locate qq-bot-v2 repository root')
    current = parent
  }
}

export function getWorkspaceRoot(): string {
  return join(getRepositoryRoot(), 'data', 'agent-workspace')
}
