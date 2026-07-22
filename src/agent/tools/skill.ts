import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { Tool } from '../tool.js'

const DEFAULT_SKILLS_DIR = 'docs/agent-skills'
const DEFAULT_MAX_CONTENT_CHARS = 8_000
const SKILL_NAME_REGEX = /^[a-z0-9_-]+$/

const argsSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list').describe('列出可按需加载的 skill 目录.'),
  }),
  z.object({
    action: z.literal('load').describe('按名称加载一个 skill 的完整说明.'),
    name: z.string().trim().min(1).max(80).describe('精确 skill 名称; 已知名称可直接 load, 不知道候选时先 action=list.'),
  }),
])

type Args = z.infer<typeof argsSchema>

interface SkillEntry {
  name: string
  description: string
  path: string
  body: string
}

export interface SkillToolDeps {
  skillsDir?: string
  maxContentChars?: number
}

export function createSkillTool(deps: SkillToolDeps = {}): Tool<Args> {
  const skillsDir = deps.skillsDir ?? DEFAULT_SKILLS_DIR
  const maxContentChars = deps.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS

  return {
    name: 'skill',
    description: [
      '按需加载仓库内的长说明和工作流.',
      'action=list: 查看有哪些 skill.',
      'action=load: 按精确 name 读取正文, 输出有长度上限; 已知 name 时直接 load, 不知道候选时才 list.',
      '遇到不熟悉的专项规则、安全边界或标准工作流时加载匹配 skill；当前连续执行状态不要写进 skill.',
      '当前方向耗尽、连续静默或准备因为“没事做”而休息时直接 load autonomous_life; 已有明确方向时不要加载.',
      '简单日常回复、已知单步操作或只是步骤多但规则已清楚的任务不要调用; 不要把长手册塞进常驻上下文.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = argsSchema.parse(rawArgs)
      const catalog = await readCatalog(skillsDir)

      if (args.action === 'list') {
        const noveltyKey = `skill_catalog:${stableHash(JSON.stringify(
          catalog.map(({ name, description }) => ({ name, description })),
        ))}`
        return {
          content: JSON.stringify({
            ok: true,
            skills: catalog.map(({ name, description }) => ({ name, description })),
          }),
          outcome: {
            ok: true,
            progress: false,
            continuation: 'immediate',
            noveltyKey,
          },
        }
      }

      const entry = catalog.find((skill) => skill.name === args.name)
      if (!entry) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `Unknown skill: ${args.name}`,
            available: catalog.map((skill) => skill.name),
          }),
        }
      }

      const truncated = entry.body.length > maxContentChars
      return {
        content: JSON.stringify({
          ok: true,
          name: entry.name,
          description: entry.description,
          content: truncated ? entry.body.slice(0, maxContentChars) : entry.body,
          truncated,
        }),
        outcome: {
          ok: true,
          progress: true,
          continuation: 'immediate',
          noveltyKey: `skill:${entry.name}:${stableHash(entry.body)}`,
        },
      }
    },
  }
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

async function readCatalog(skillsDir: string): Promise<SkillEntry[]> {
  let names: string[]
  try {
    names = await readdir(skillsDir)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return []
    throw err
  }

  const entries: SkillEntry[] = []
  for (const fileName of names.sort()) {
    if (!fileName.endsWith('.md')) continue
    const path = join(skillsDir, fileName)
    const raw = await readFile(path, 'utf-8')
    const parsed = parseSkillFile(raw, basename(fileName, '.md'), path)
    if (parsed) entries.push(parsed)
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function parseSkillFile(raw: string, fallbackName: string, path: string): SkillEntry | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  let name = fallbackName
  let description = ''
  let body = raw.trim()

  if (match) {
    const frontmatter = parseYaml(match[1] ?? '') as unknown
    if (frontmatter && typeof frontmatter === 'object') {
      const meta = frontmatter as Record<string, unknown>
      if (typeof meta.name === 'string') name = meta.name.trim()
      if (typeof meta.description === 'string') description = meta.description.trim()
    }
    body = raw.slice(match[0].length).trim()
  }

  if (!SKILL_NAME_REGEX.test(name) || !description) return null
  return { name, description, path, body }
}

export const skillTool = createSkillTool()
