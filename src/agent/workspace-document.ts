import { createHash, randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { normalize, resolve, sep } from 'node:path'
import type { WorkspaceStateCoordinator } from './workspace-state-coordinator.js'

export function revisionOfText(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function assertTextRevision(
  content: string,
  expectedRevision: string,
  error: () => Error,
): void {
  if (revisionOfText(content) !== expectedRevision) throw error()
}

export async function atomicWriteText(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export function withResourceWrite<T>(
  coordinator: WorkspaceStateCoordinator | undefined,
  resourceKey: string,
  task: () => Promise<T>,
): Promise<T> {
  return coordinator ? coordinator.withWrite(resourceKey, task) : task()
}

export function safeWorkspacePath(input: {
  rootDir: string
  relativeFile: string
  extension?: string
  label?: string
}): string {
  const normalized = normalize(input.relativeFile).replace(/\\/g, '/')
  const extension = input.extension ?? '.md'
  const label = input.label ?? 'workspace file'
  if (!normalized.endsWith(extension) || normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    throw new Error(`${label} is not allowed: ${input.relativeFile}`)
  }
  const root = resolve(input.rootDir)
  const resolved = resolve(root, normalized)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes root: ${input.relativeFile}`)
  }
  return resolved
}
