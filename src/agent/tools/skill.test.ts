import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { InMemoryEventQueue } from '../event-queue.js'
import type { BotEvent } from '../event.js'
import type { ToolContext } from '../tool.js'
import { createSkillTool } from './skill.js'

function makeCtx(): ToolContext {
  return { eventQueue: new InMemoryEventQueue<BotEvent>(), roundIndex: 1 }
}

async function makeSkillDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qq-bot-skills-'))
  await writeFile(join(dir, 'repo_map.md'), [
    '---',
    'name: repo_map',
    'description: 仓库知识地图',
    '---',
    '',
    '# Repo Map',
    '',
    '优先读 docs/README.md。',
  ].join('\n'))
  await writeFile(join(dir, 'tool_help.md'), [
    '---',
    'name: tool_help',
    'description: 工具帮助入口',
    '---',
    '',
    '# Tool Help',
    '',
    '不确定 workspace_bash 语法时先 help。',
  ].join('\n'))
  await writeFile(join(dir, 'missing_description.md'), '# Missing description\n')
  return dir
}

describe('skill tool', () => {
  test('list returns the curated skill catalog sorted by name', async () => {
    const tool = createSkillTool({ skillsDir: await makeSkillDir() })

    const listed = JSON.parse((await tool.execute({ action: 'list' }, makeCtx())).content as string) as {
      ok: boolean
      skills: { name: string; description: string }[]
    }

    assert.equal(listed.ok, true)
    assert.deepEqual(listed.skills.map((skill) => skill.name), ['repo_map', 'tool_help'])
    assert.equal(listed.skills[0]?.description, '仓库知识地图')
  })

  test('load returns bounded content by skill name and rejects unknown names', async () => {
    const tool = createSkillTool({ skillsDir: await makeSkillDir(), maxContentChars: 20 })

    assert.match(tool.description, /已知 name 时直接 load.*不知道候选时才 list/)
    assert.match(tool.description, /执行步骤和状态改用 todo/)

    const loaded = JSON.parse((await tool.execute({ action: 'load', name: 'tool_help' }, makeCtx())).content as string) as {
      ok: boolean
      name: string
      content: string
      truncated?: boolean
    }
    const rejected = JSON.parse((await tool.execute({ action: 'load', name: '../repo_map' }, makeCtx())).content as string) as {
      ok: boolean
      error?: string
    }

    assert.equal(loaded.ok, true)
    assert.equal(loaded.name, 'tool_help')
    assert.ok(loaded.content.length <= 20)
    assert.equal(loaded.truncated, true)
    assert.equal(rejected.ok, false)
    assert.match(rejected.error ?? '', /Unknown skill/)
  })

  test('default catalog contains runtime-facing skills and excludes developer roadmap docs', async () => {
    const tool = createSkillTool()

    const listed = JSON.parse((await tool.execute({ action: 'list' }, makeCtx())).content as string) as {
      skills: { name: string }[]
    }
    const names = listed.skills.map((skill) => skill.name)

    assert.deepEqual(names, [
      'background_task_workflow',
      'browser_workflow',
      'context_hygiene',
      'crypto_paper',
      'debugging_workflow',
      'external_research_hygiene',
      'media_handle_workflow',
      'memory_hygiene',
      'moomooapi',
      'observability_hygiene',
      'qq_interaction_policy',
      'replay_safety',
      'repo_change_workflow',
      'repo_map',
      'self_review_repo',
      'todo_workflow',
      'tool_contract_design',
      'tool_help',
      'tool_security',
    ])
    assert.equal(names.includes('harness_route'), false)
  })

  test('default catalog descriptions disclose both activation and exclusion boundaries', async () => {
    const tool = createSkillTool()

    const listed = JSON.parse((await tool.execute({ action: 'list' }, makeCtx())).content as string) as {
      skills: { name: string; description: string }[]
    }

    for (const skill of listed.skills) {
      assert.match(skill.description, /(?:时使用|前使用|用于|需要|当|适合)/, `${skill.name} 缺少正触发条件`)
      assert.match(skill.description, /(?:不要使用|不适合|无需使用|无须使用|改用|优先用)/, `${skill.name} 缺少负触发或替代入口`)
    }
  })

  test('memory hygiene skill describes autonomous consolidation before permanent deletion', async () => {
    const tool = createSkillTool()

    const loaded = JSON.parse((await tool.execute({
      action: 'load',
      name: 'memory_hygiene',
    }, makeCtx())).content as string) as { ok: boolean; content: string }

    assert.equal(loaded.ok, true)
    assert.match(loaded.content, /memory.*action=recall/s)
    assert.match(loaded.content, /memory.*action=review/s)
    assert.match(loaded.content, /promote_entry.*update_entry.*compact.*delete_entry/s)
    assert.match(loaded.content, /maintenance lane/)
    assert.match(loaded.content, /不按固定时间/)
  })
})
