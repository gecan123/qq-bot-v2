import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import type { Tool } from '../tool.js'

const DEFAULT_DRAFTS_DIR = 'data/agent-workspace/skill-drafts'
const DEFAULT_SKILLS_DIR = 'docs/agent-skills'
const MAX_CONTENT_CHARS = 6_000
const MAX_DESCRIPTION_CHARS = 240
const SKILL_NAME_REGEX = /^[a-z0-9_-]+$/
const USE_TRIGGER_REGEX = /(?:时使用|前使用|用于|需要|当|适合|use this skill when|use when)/i
const EXCLUSION_TRIGGER_REGEX = /(?:不要使用|不适合|无需使用|无须使用|改用|优先用|do not use|don't use|not for|instead)/i

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('draft').describe('写入一个 skill 草稿, 不会被 skill 工具加载.'),
    name: z.string().trim().regex(SKILL_NAME_REGEX).max(80).describe('skill 名称, 只允许小写字母、数字、下划线和连字符.'),
    description: z.string().trim().min(1).max(MAX_DESCRIPTION_CHARS).describe('skill 目录触发描述, 必须说明何时使用, 以及最容易混淆的何时不要使用或应改用什么.'),
    content: z.string().trim().min(1).max(MAX_CONTENT_CHARS).describe('skill Markdown 正文, 不含 frontmatter.'),
  }),
  z.object({
    action: z.literal('validate').describe('校验一个草稿是否可安装.'),
    name: z.string().trim().regex(SKILL_NAME_REGEX).max(80),
  }),
  z.object({
    action: z.literal('install').describe('把已验证草稿安装到 docs/agent-skills. 默认拒绝覆盖已有 skill.'),
    name: z.string().trim().regex(SKILL_NAME_REGEX).max(80),
  }),
  z.object({
    action: z.literal('list_drafts').describe('列出 skill 草稿.'),
  }),
  z.object({
    action: z.literal('read_draft').describe('读取一个 skill 草稿.'),
    name: z.string().trim().regex(SKILL_NAME_REGEX).max(80),
  }),
  z.object({
    action: z.literal('delete_draft').describe('永久删除一个明确的未安装 skill 草稿.'),
    name: z.string().trim().regex(SKILL_NAME_REGEX).max(80),
  }),
])

type Args = z.infer<typeof argsSchema>

interface SkillDraft {
  name: string
  description: string
  content: string
  raw: string
}

export interface SkillEditorToolDeps {
  draftsDir?: string
  skillsDir?: string
}

function markdownPath(dir: string, name: string): string {
  return join(dir, `${name}.md`)
}

function renderSkillMarkdown(name: string, description: string, content: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    content.trim(),
    '',
  ].join('\n')
}

function parseDraft(raw: string, fallbackName: string): SkillDraft | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  if (!match) return null

  const frontmatter = parseYaml(match[1] ?? '') as unknown
  if (!frontmatter || typeof frontmatter !== 'object') return null
  const meta = frontmatter as Record<string, unknown>
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string') return null

  return {
    name: meta.name.trim(),
    description: meta.description.trim(),
    content: raw.slice(match[0].length).trim(),
    raw,
  }
}

function validateSkillDraft(draft: SkillDraft | null): string[] {
  const errors: string[] = []
  if (!draft) return ['草稿缺少有效 frontmatter']

  if (!SKILL_NAME_REGEX.test(draft.name)) errors.push('skill name 只能包含小写字母、数字、下划线和连字符')
  if (!draft.description) errors.push('description 不能为空')
  if (draft.description.length > MAX_DESCRIPTION_CHARS) errors.push(`description 不能超过 ${MAX_DESCRIPTION_CHARS} 字符`)
  if (draft.description && !USE_TRIGGER_REGEX.test(draft.description)) {
    errors.push('description 必须说明何时使用')
  }
  if (draft.description && !EXCLUSION_TRIGGER_REGEX.test(draft.description)) {
    errors.push('description 必须说明何时不要使用或应改用什么')
  }
  if (!draft.content) errors.push('正文不能为空')
  if (draft.content.length > MAX_CONTENT_CHARS) errors.push(`正文不能超过 ${MAX_CONTENT_CHARS} 字符`)
  errors.push(...detectUnsafeContent(`${draft.description}\n${draft.content}`))
  return errors
}

function detectUnsafeContent(value: string): string[] {
  const lowered = value.toLowerCase()
  const patterns: Array<[RegExp | string, string]> = [
    [/忽略.*(前文|指令|规则|system|系统)/i, '危险内容: 不允许要求忽略系统或上级指令'],
    ['ignore previous instructions', '危险内容: 不允许要求忽略系统或上级指令'],
    [/自动.*send_message/i, '危险内容: 不允许要求自动对外发送消息'],
    [/自动.*(所有群|群聊)/i, '危险内容: 不允许要求自动群发或扩大目标'],
    [/泄露|导出.*(token|secret|cookie|密码)/i, '危险内容: 不允许要求泄露敏感信息'],
    ['bypass', '危险内容: 不允许要求绕过安全边界'],
  ]

  return patterns
    .filter(([pattern]) => typeof pattern === 'string' ? lowered.includes(pattern) : pattern.test(value))
    .map(([, message]) => message)
}

async function readDraft(draftsDir: string, name: string): Promise<SkillDraft | null> {
  try {
    const raw = await readFile(markdownPath(draftsDir, name), 'utf8')
    return parseDraft(raw, name)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return false
    throw err
  }
}

async function listDrafts(draftsDir: string) {
  let names: string[]
  try {
    names = await readdir(draftsDir)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return []
    throw err
  }

  const drafts = []
  for (const fileName of names.sort()) {
    if (!fileName.endsWith('.md')) continue
    const name = basename(fileName, '.md')
    const draft = await readDraft(draftsDir, name)
    if (!draft) continue
    drafts.push({ name: draft.name, description: draft.description })
  }
  return drafts.sort((a, b) => a.name.localeCompare(b.name))
}

function invalidArgsResult(error: unknown) {
  return {
    content: JSON.stringify({
      ok: false,
      code: 'invalid_arguments',
      error: `Invalid tool arguments: ${error instanceof Error ? error.message : String(error)}`,
    }),
    outcome: { ok: false, code: 'invalid_arguments' },
  }
}

export function createSkillEditorTool(deps: SkillEditorToolDeps = {}): Tool<Args> {
  const draftsDir = deps.draftsDir ?? DEFAULT_DRAFTS_DIR
  const skillsDir = deps.skillsDir ?? DEFAULT_SKILLS_DIR

  return {
    name: 'skill_editor',
    description: [
      '创建和安装运行时 skill 的受控工具.',
      'action=draft 写入草稿到私有工作区, 不会立即影响 skill 列表.',
      'action=validate 校验草稿; action=install 将已验证草稿安装为 docs/agent-skills/<name>.md, 默认拒绝覆盖.',
      'action=delete_draft 删除不再需要的草稿; 不会删除已安装 skill.',
      '只用于沉淀稳定、可复用的工作流; 不要把普通聊天、一次性总结或危险指令写成 skill.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const parsed = argsSchema.safeParse(rawArgs)
      if (!parsed.success) return invalidArgsResult(parsed.error)
      const args = parsed.data

      if (args.action === 'draft') {
        const draft = {
          name: args.name,
          description: args.description,
          content: args.content,
          raw: renderSkillMarkdown(args.name, args.description, args.content),
        }
        const errors = validateSkillDraft(draft)
        if (errors.length > 0) {
          return {
            content: JSON.stringify({ ok: false, code: 'validation_failed', errors }),
            outcome: { ok: false, code: 'validation_failed' },
          }
        }
        await mkdir(draftsDir, { recursive: true })
        const path = markdownPath(draftsDir, args.name)
        await writeFile(path, draft.raw, 'utf8')
        return { content: JSON.stringify({ ok: true, action: 'draft', name: args.name, path }) }
      }

      if (args.action === 'list_drafts') {
        return { content: JSON.stringify({ ok: true, drafts: await listDrafts(draftsDir) }) }
      }

      if (args.action === 'read_draft') {
        const draft = await readDraft(draftsDir, args.name)
        if (!draft) {
          return {
            content: JSON.stringify({ ok: false, code: 'not_found', error: 'draft not found' }),
            outcome: { ok: false, code: 'not_found' },
          }
        }
        return {
          content: JSON.stringify({
            ok: true,
            name: draft.name,
            description: draft.description,
            content: draft.content,
          }),
        }
      }

      if (args.action === 'delete_draft') {
        const path = markdownPath(draftsDir, args.name)
        try {
          await unlink(path)
          return {
            content: JSON.stringify({ ok: true, action: 'delete_draft', name: args.name, path }),
            outcome: { ok: true },
          }
        } catch (err) {
          if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
            return {
              content: JSON.stringify({ ok: false, code: 'not_found', error: 'draft not found' }),
              outcome: { ok: false, code: 'not_found' },
            }
          }
          throw err
        }
      }

      const draft = await readDraft(draftsDir, args.name)
      const errors = validateSkillDraft(draft)
      if (args.action === 'validate') {
        return { content: JSON.stringify({ ok: true, valid: errors.length === 0, errors }) }
      }

      if (!draft) {
        return {
          content: JSON.stringify({ ok: false, code: 'not_found', error: 'draft not found' }),
          outcome: { ok: false, code: 'not_found' },
        }
      }
      if (errors.length > 0) {
        return {
          content: JSON.stringify({ ok: false, code: 'validation_failed', errors }),
          outcome: { ok: false, code: 'validation_failed' },
        }
      }
      const target = markdownPath(skillsDir, args.name)
      if (await fileExists(target)) {
        return {
          content: JSON.stringify({ ok: false, code: 'already_exists', error: 'installed skill already exists' }),
          outcome: { ok: false, code: 'already_exists' },
        }
      }
      await mkdir(skillsDir, { recursive: true })
      await copyFile(markdownPath(draftsDir, args.name), target)
      return { content: JSON.stringify({ ok: true, action: 'install', installed: true, name: args.name, path: target }) }
    },
  }
}

export const skillEditorTool = createSkillEditorTool()
