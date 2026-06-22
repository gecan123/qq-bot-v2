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

export function loadPromptSection(filePath: string, section: string): string {
  const content = loadPrompt(filePath)
  const pattern = new RegExp(
    `<!--\\s*section:${escapeRegExp(section)}\\s*-->\\n?([\\s\\S]*?)\\n?<!--\\s*/section:${escapeRegExp(section)}\\s*-->`,
    'm',
  )
  const match = content.match(pattern)
  if (!match) {
    throw new Error(`Missing prompt section "${section}" in ${filePath}`)
  }
  return match[1]!.trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
