import { normalize } from 'node:path'

const CONTENT_WRITE_EXTENSIONS = new Set(['.md', '.mdx', '.json', '.txt'])
const IMAGE_WRITE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg'])

export function safeWebsiteRelativePath(file: string): string | null {
  const trimmed = file.trim()
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\\')) return null
  if (trimmed.split('/').some((segment) => segment === '..' || segment.startsWith('.'))) return null

  const normalized = normalize(trimmed).split('\\').join('/')
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.split('/').some((segment) => segment === '..' || segment.startsWith('.'))
  ) {
    return null
  }

  return normalized
}

export function isAllowedWebsiteReadPath(file: string): boolean {
  const normalized = safeWebsiteRelativePath(file)
  if (!normalized) return false
  return isAllowedWebsitePath(normalized)
}

export function isAllowedWebsiteWritePath(file: string): boolean {
  const normalized = safeWebsiteRelativePath(file)
  if (!normalized) return false
  return isAllowedWebsitePath(normalized)
}

function isAllowedWebsitePath(file: string): boolean {
  const ext = extensionOf(file)
  if (file.startsWith('src/content/')) return CONTENT_WRITE_EXTENSIONS.has(ext)
  if (file === 'src/pages/about.astro') return ext === '.astro'
  if (file === 'src/styles/tokens.css') return ext === '.css'
  if (file === 'src/styles/components.css') return ext === '.css'
  if (file.startsWith('public/images/')) return IMAGE_WRITE_EXTENSIONS.has(ext)
  return false
}

function extensionOf(file: string): string {
  const index = file.lastIndexOf('.')
  return index >= 0 ? file.slice(index).toLowerCase() : ''
}
