import * as fs from 'node:fs'
import * as path from 'node:path'

const cache = new Map<string, string>()

export function loadPrompt(filePath: string): string {
  const resolved = path.resolve(filePath)
  if (cache.has(resolved)) return cache.get(resolved)!
  const content = fs.readFileSync(resolved, 'utf-8').trim()
  cache.set(resolved, content)
  return content
}
