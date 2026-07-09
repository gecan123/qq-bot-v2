import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  isAllowedWebsiteReadPath,
  isAllowedWebsiteWritePath,
  safeWebsiteRelativePath,
} from './website.js'

describe('website path policy', () => {
  test('allows Astro content and narrow style paths', () => {
    assert.equal(isAllowedWebsiteReadPath('src/content/posts/hello.md'), true)
    assert.equal(isAllowedWebsiteWritePath('src/content/posts/hello.md'), true)
    assert.equal(isAllowedWebsiteReadPath('src/content/notes/today.mdx'), true)
    assert.equal(isAllowedWebsiteWritePath('src/content/notes/today.mdx'), true)
    assert.equal(isAllowedWebsiteReadPath('src/content/profile.json'), true)
    assert.equal(isAllowedWebsiteWritePath('src/content/profile.json'), true)
    assert.equal(isAllowedWebsiteReadPath('src/pages/about.astro'), true)
    assert.equal(isAllowedWebsiteWritePath('src/pages/about.astro'), true)
    assert.equal(isAllowedWebsiteReadPath('src/styles/tokens.css'), true)
    assert.equal(isAllowedWebsiteWritePath('src/styles/tokens.css'), true)
    assert.equal(isAllowedWebsiteReadPath('src/styles/components.css'), true)
    assert.equal(isAllowedWebsiteWritePath('src/styles/components.css'), true)
    assert.equal(isAllowedWebsiteReadPath('public/images/avatar.webp'), true)
    assert.equal(isAllowedWebsiteWritePath('public/images/avatar.webp'), true)
  })

  test('rejects config, ci, hidden files, scripts, and path escape', () => {
    const rejected = [
      '../secret.md',
      '/tmp/file.md',
      '.env',
      'src/content/.draft.md',
      '.github/workflows/deploy.yml',
      '.vercel/project.json',
      'package.json',
      'pnpm-lock.yaml',
      'astro.config.mjs',
      'tsconfig.json',
      'src/pages/index.astro',
      'src/styles/global.css',
      'scripts/build.js',
      'public/images/evil.js',
    ]

    for (const file of rejected) {
      assert.equal(isAllowedWebsiteReadPath(file), false, file)
      assert.equal(isAllowedWebsiteWritePath(file), false, file)
    }
  })

  test('rejects text files under public images', () => {
    const rejected = [
      'public/images/readme.md',
      'public/images/style.css',
      'public/images/data.json',
    ]

    for (const file of rejected) {
      assert.equal(isAllowedWebsiteReadPath(file), false, file)
      assert.equal(isAllowedWebsiteWritePath(file), false, file)
    }
  })

  test('rejects non-content extensions under Astro content', () => {
    const rejected = [
      'src/content/posts/photo.png',
      'src/content/posts/style.css',
      'src/content/posts/page.astro',
    ]

    for (const file of rejected) {
      assert.equal(isAllowedWebsiteReadPath(file), false, file)
      assert.equal(isAllowedWebsiteWritePath(file), false, file)
    }
  })

  test('normalizes safe relative paths', () => {
    assert.equal(safeWebsiteRelativePath('src/content/posts/hello.md'), 'src/content/posts/hello.md')
    assert.equal(safeWebsiteRelativePath('src/content/posts//hello.md'), 'src/content/posts/hello.md')
    assert.equal(safeWebsiteRelativePath('src\\content\\posts\\hello.md'), null)
    assert.equal(safeWebsiteRelativePath('../hello.md'), null)
  })

  test('rejects raw parent and hidden path segments before normalization', () => {
    const rejected = [
      'src/content/../content/posts/hello.md',
      'src/content/.hidden/../posts/hello.md',
    ]

    for (const file of rejected) {
      assert.equal(safeWebsiteRelativePath(file), null, file)
      assert.equal(isAllowedWebsiteReadPath(file), false, file)
      assert.equal(isAllowedWebsiteWritePath(file), false, file)
    }
  })
})
