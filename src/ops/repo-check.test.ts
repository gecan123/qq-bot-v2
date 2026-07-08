import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runRepoChecks } from './repo-check.js'

const validFiles = {
  'AGENTS.md': [
    '# Repository Agent Instructions',
    '',
    'Read `docs/README.md` for the repository knowledge map.',
    'Read `docs/AGENT_CONTEXT.md` before changing persistent context.',
  ].join('\n'),
  'CLAUDE.md': [
    '# Repository Agent Instructions',
    '',
    'Read `docs/README.md` for the repository knowledge map.',
    'Read `docs/AGENT_CONTEXT.md` before changing persistent context.',
  ].join('\n'),
  'README.md': [
    '# qq-bot-v2',
    '',
    'Uses `bot_agent_snapshot` for the single persistent AgentContext.',
    'Run `pnpm repo-check` before handing work back.',
  ].join('\n'),
  'package.json': JSON.stringify({
    scripts: {
      'repo-check': 'tsx scripts/repo-check.ts',
      'agent:doctor': 'tsx scripts/agent-doctor.ts',
      'agent:metrics': 'tsx scripts/agent-metrics.ts',
      lint: 'pnpm typecheck && pnpm repo-check',
    },
  }),
  'src/agent/tools/index.ts': [
    'createDeferredToolExecutor',
    'pauseTool,',
    'createSendMessageTool({',
    'createGenerateImageTool({ taskRegistry: deps.taskRegistry }),',
    'createBackgroundTaskTool({ taskRegistry: deps.taskRegistry }),',
    'memoryTool,',
    'collectStickerTool,',
    'createWorkspaceBashTool({',
    'const browser = maybeCreateBrowserTool()',
    'const webSearch = maybeCreateWebSearchTool()',
  ].join('\n'),
  'src/agent/tools/workspace-bash.ts': [
    'function parseHelpCommand',
    'function parseJournalCommand',
    'function parseDbToolCommand',
    'function parseStyleCommand',
    'function parseOpenbbCommand',
    'function parseFetchCommand',
    "topic?: 'workspace' | 'repo' | 'journal' | 'db' | 'style' | 'openbb' | 'fetch'",
    "if (tokens[0] === 'help')",
  ].join('\n'),
  'prompts/bot-system.md': [
    '- help: 需要浏览器、金融数据、外部研究、图片生成/抓取时, 先 action=list/describe 查看 capability 和内部工具 schema, 再 action=activate 激活对应 capability.',
    '- invoke: 调用已激活 capability 内部工具时使用, 例如 tool=browser / web_search / fetch_content / generate_image / openbb_cli.',
    '- workspace_bash: 不确定语法先用 `help`; 日记/梦境用 `journal write|list|search|read`; 数据库用 `db schema` / `db query <json>`; 风格用 `style global [constraints|base|anti_patterns|special_cases]` / `style group <groupId>`; 只读查看自己仓库代码、做自审时用 cwd=repo.',
    '- memory: 涉及具体人/群、关系、偏好、旧话题时先 action=search 翻私人笔记; 需要记下长期有用事实时 action=write.',
    '异步工具返回 taskId 后统一用 background_task action=list/get 查状态和结果',
  ].join('\n'),
  'prompts/bot-chat-constraints.md': '<!-- section:chat_constraints -->\n聊天约束\n单条消息 ≤ 500 字.\n<!-- /section:chat_constraints -->\n',
  'prompts/bot-style.md': '<!-- section:style_index -->\nLuna 按需风格指南\nconstraints\n<!-- /section:style_index -->\n',
  'prisma/schema.prisma': 'model BotAgentSnapshot {\n  @@map("bot_agent_snapshot")\n}\n',
  'docs/README.md': 'docs/ARCHITECTURE.md\ndocs/AGENT_CONTEXT.md\ndocs/TOOLS.md\ndocs/OPERATIONS.md\ndocs/TECH_DEBT.md\n',
  'docs/ARCHITECTURE.md': '# Architecture\n',
  'docs/AGENT_CONTEXT.md': '# Persistent Agent Context\n',
  'docs/TOOLS.md': [
    '# Agent Tools',
    '`help` `invoke` `pause` `send_message` `generate_image` `background_task` `memory` `collect_sticker` `workspace_bash` `browser` `web_search`',
    '`help` `journal` `db` `style` `openbb` `fetch`',
  ].join('\n'),
  'docs/OPERATIONS.md': '# Operations\n',
  'docs/TECH_DEBT.md': '# Technical Debt\n',
}

describe('runRepoChecks', () => {
  test('accepts mirrored agent instructions and current repository map', () => {
    const result = runRepoChecks(validFiles)

    assert.deepEqual(result.errors, [])
  })

  test('rejects stale README references to removed architecture surfaces', () => {
    const result = runRepoChecks({
      ...validFiles,
      'README.md': 'Use scene_agent_contexts and reply_records in admin-web.',
    })

    assert.match(result.errors.join('\n'), /README\.md references removed surface "scene_agent_contexts"/)
    assert.match(result.errors.join('\n'), /README\.md references removed surface "reply_records"/)
    assert.match(result.errors.join('\n'), /README\.md references removed surface "admin-web"/)
  })

  test('rejects package scripts that do not expose repo-check through lint', () => {
    const result = runRepoChecks({
      ...validFiles,
      'package.json': JSON.stringify({
        scripts: {
          lint: 'pnpm typecheck',
        },
      }),
    })

    assert.match(result.errors.join('\n'), /package\.json must define scripts\["repo-check"\]/)
    assert.match(result.errors.join('\n'), /package\.json scripts\.lint must run repo-check/)
  })

  test('rejects documenting collect_sticker as a workspace_bash subcommand', () => {
    const result = runRepoChecks({
      ...validFiles,
      'docs/TOOLS.md': [
        '# Agent Tools',
        '`help` `invoke` `pause` `send_message` `generate_image` `background_task` `memory` `workspace_bash` `browser` `web_search`',
        '`help` `journal` `db` `style` `openbb` `fetch` `collect_sticker`',
        '`collect_sticker` belongs under `workspace_bash` for sticker collection.',
      ].join('\n'),
    })

    assert.match(result.errors.join('\n'), /docs\/TOOLS\.md must not document collect_sticker as a workspace_bash subcommand/)
  })

  test('accepts documenting collect_sticker as explicitly outside workspace_bash', () => {
    const result = runRepoChecks({
      ...validFiles,
      'docs/TOOLS.md': [
        '# Agent Tools',
        '`help` `invoke` `pause` `send_message` `generate_image` `background_task` `memory` `collect_sticker` `workspace_bash` `browser` `web_search`',
        '`help` `journal` `db` `style` `openbb` `fetch`',
        '`collect_sticker` is not a `workspace_bash` subcommand.',
      ].join('\n'),
    })

    assert.deepEqual(result.errors, [])
  })

  test('rejects missing operational feedback scripts', () => {
    const result = runRepoChecks({
      ...validFiles,
      'package.json': JSON.stringify({
        scripts: {
          'repo-check': 'tsx scripts/repo-check.ts',
          lint: 'pnpm typecheck && pnpm repo-check',
        },
      }),
    })

    assert.match(result.errors.join('\n'), /package\.json must define scripts\["agent:doctor"\]/)
    assert.match(result.errors.join('\n'), /package\.json must define scripts\["agent:metrics"\]/)
  })

  test('rejects stale README environment variable names', () => {
    const result = runRepoChecks({
      ...validFiles,
      'README.md': 'Configure `GROUP_IDS` before startup. Uses `bot_agent_snapshot`.',
    })

    assert.match(result.errors.join('\n'), /README\.md references stale env var "GROUP_IDS"/)
  })

  test('rejects oversized agent entry files and missing docs links', () => {
    const longEntry = Array.from({ length: 121 }, (_, i) => `line ${i}`).join('\n')
    const result = runRepoChecks({
      ...validFiles,
      'AGENTS.md': longEntry,
      'CLAUDE.md': longEntry,
    })

    assert.match(result.errors.join('\n'), /AGENTS\.md should stay short/)
    assert.match(result.errors.join('\n'), /AGENTS\.md must link docs\/README\.md/)
    assert.match(result.errors.join('\n'), /AGENTS\.md must link docs\/AGENT_CONTEXT\.md/)
  })

  test('rejects missing required documentation map entries', () => {
    const result = runRepoChecks({
      ...validFiles,
      'docs/README.md': 'docs/ARCHITECTURE.md\n',
      'docs/TOOLS.md': '',
    })

    assert.match(result.errors.join('\n'), /docs\/README\.md must link docs\/AGENT_CONTEXT\.md/)
    assert.match(result.errors.join('\n'), /docs\/TOOLS\.md must not be empty/)
  })

  test('rejects tool registry drift from docs and prompt indexes', () => {
    const result = runRepoChecks({
      ...validFiles,
      'docs/TOOLS.md': '# Agent Tools\n`pause` `send_message` `workspace_bash`\n`journal` `db`\n',
      'prompts/bot-system.md': '- workspace_bash: 日记/梦境用 `journal write|list|search|read`.\n',
    })

    assert.match(result.errors.join('\n'), /docs\/TOOLS\.md must mention registered tool "generate_image"/)
    assert.match(result.errors.join('\n'), /docs\/TOOLS\.md must mention workspace_bash subcommand "help"/)
    assert.match(result.errors.join('\n'), /prompts\/bot-system\.md must mention workspace_bash subcommand "help"/)
  })
})
