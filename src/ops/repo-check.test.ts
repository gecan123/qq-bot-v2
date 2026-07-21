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
    'Uses `bot_agent_ledger_entries` for the persistent LLM ledger.',
    'Run `pnpm repo-check` before handing work back.',
  ].join('\n'),
  'package.json': JSON.stringify({
    scripts: {
      'repo-check': 'tsx scripts/repo-check.ts',
      'agent:doctor': 'tsx scripts/agent-doctor.ts',
      'agent:metrics': 'tsx scripts/agent-metrics.ts',
      'agent:daily-metrics': 'tsx scripts/agent-daily-metrics.ts',
      'agent:memory-check': 'tsx scripts/agent-memory-check.ts',
      'agent:ledger-check': 'tsx scripts/agent-ledger-check.ts',
      'agent:reset-state': 'tsx scripts/reset-agent-state.ts --confirm',
      lint: 'pnpm typecheck && pnpm repo-check',
    },
  }),
  '.env.example': [
    'BOT_EVENT_DEBOUNCE_MS=3000',
    'BOT_TOKEN_USAGE_LOG_PATH=logs/token-usage.ndjson',
    'BOT_OBSERVABILITY_RETENTION_DAYS=30',
  ].join('\n'),
  'prompts/groups.md': '# 群聊配置\n\n## 群 111\n\n- participation: mentions\n',
  'src/agent/tools/index.ts': [
    'createDeferredToolExecutor',
    'pauseTool,',
    'createSendMessageTool({',
    'createGenerateImageTool({ taskRegistry: deps.taskRegistry }),',
    'createBackgroundTaskTool({ taskRegistry: deps.taskRegistry }),',
    'memoryTool,',
    'collectStickerTool,',
    'createWorkspaceBashTool({',
    'workspaceFileTool,',
    'const browser = maybeCreateBrowserTool()',
    'const webSearch = maybeCreateWebSearchTool()',
  ].join('\n'),
  'src/agent/tools/workspace-bash.ts': [
    'function parseHelpCommand',
    'function parseDbToolCommand',
    'function parseStyleCommand',
    'function parseOpenbbCommand',
    'function parseFetchCommand',
    'function parseMetricsCommand',
    "topic?: 'workspace' | 'repo' | 'db' | 'style' | 'openbb' | 'fetch' | 'metrics'",
    "if (tokens[0] === 'help')",
  ].join('\n'),
  'prompts/system/system.md': [
    '- help: 需要浏览器、金融数据、外部研究、图片生成/抓取时, 先 action=list/describe 查看 capability 和内部工具 schema, 再 action=activate 激活对应 capability.',
    '- invoke: 调用已激活 capability 内部工具时使用, 例如 tool=browser / web_search / fetch_content / generate_image / openbb_cli.',
    '- workspace_bash: 不确定语法先用 `help`; 数据库用 `db schema` / `db query <json>`; 每日统计用 `metrics today`; 风格用 `style global` / `style group <groupId>`; 只读查看自己仓库代码、做自审时用 cwd=repo.',
    '- memory: 涉及具体人/群、关系、偏好、旧话题时先 action=search 翻私人笔记; 需要记下长期有用事实时 action=write.',
    '- chat_style / style: 先读取全局风格索引，再按具体主题读取。',
    '异步工具返回 taskId 后统一用 background_task action=list/get 查状态和结果',
  ].join('\n'),
  'prompts/system/persona.md': '你是 Luna。\n',
  'prompts/system/owner.md': '[关系基线]\n',
  'prompts/chat-style/index.md': 'constraints\nbase\nanti_patterns\nroleplay\nnsfw\n',
  'prompts/chat-style/constraints.md': '聊天约束\n单条消息 ≤ 500 字.\n',
  'prompts/chat-style/base.md': '全局说话风格。\n',
  'prompts/chat-style/anti-patterns.md': '常见反例。\n',
  'prompts/chat-style/roleplay.md': '角色扮演。\n',
  'prompts/chat-style/nsfw.md': '成人话题。\n',
  'prisma/schema.prisma': [
    'model BotAgentLedgerEntry {',
    '  @@map("bot_agent_ledger_entries")',
    '}',
    'model BotAgentRuntimeState {',
    '  @@map("bot_agent_runtime_state")',
    '}',
    'model BotAgentCheckpoint {',
    '  @@map("bot_agent_checkpoint")',
    '}',
  ].join('\n'),
  'docs/README.md': 'docs/ARCHITECTURE.md\ndocs/AGENT_CONTEXT.md\ndocs/MEMORY_ARCHITECTURE.md\ndocs/TOOLS.md\ndocs/OPERATIONS.md\ndocs/TECH_DEBT.md\n',
  'docs/ARCHITECTURE.md': '# Architecture\n',
  'docs/AGENT_CONTEXT.md': '# Persistent Agent Context\n',
  'docs/MEMORY_ARCHITECTURE.md': 'Markdown is the source of truth. No SQLite or embedding. checkpoint recovery. UNTRUSTED_DATA.\n',
  'docs/TOOLS.md': [
    '# Agent Tools',
    '`help` `invoke` `pause` `send_message` `generate_image` `background_task` `memory` `collect_sticker` `workspace_bash` `workspace_file` `browser` `web_search`',
    '`help` `db` `style` `openbb` `fetch` `metrics`',
  ].join('\n'),
  'docs/OPERATIONS.md': '# Operations\n',
  'docs/TECH_DEBT.md': '# Technical Debt\n',
}

describe('runRepoChecks', () => {
  test('accepts mirrored agent instructions and current repository map', () => {
    const result = runRepoChecks(validFiles)

    assert.deepEqual(result.errors, [])
  })

  test('requires byte-identical Admin Web agent instructions when either file exists', () => {
    const missingMirror = runRepoChecks({
      ...validFiles,
      'apps/admin-web/AGENTS.md': '# Admin Web Agent Instructions\n',
    })
    const differentMirror = runRepoChecks({
      ...validFiles,
      'apps/admin-web/AGENTS.md': '# Admin Web Agent Instructions\n',
      'apps/admin-web/CLAUDE.md': '# Different Admin Web Instructions\n',
    })

    assert.match(
      missingMirror.errors.join('\n'),
      /apps\/admin-web\/AGENTS\.md and CLAUDE\.md must be byte-identical/,
    )
    assert.match(
      differentMirror.errors.join('\n'),
      /apps\/admin-web\/AGENTS\.md and CLAUDE\.md must be byte-identical/,
    )
  })

  test('accepts byte-identical Admin Web agent instructions', () => {
    const instructions = '# Admin Web Agent Instructions\n'
    const result = runRepoChecks({
      ...validFiles,
      'apps/admin-web/AGENTS.md': instructions,
      'apps/admin-web/CLAUDE.md': instructions,
    })

    assert.deepEqual(result.errors, [])
  })

  test('rejects server-only imports and mutations in Admin Web source', () => {
    const result = runRepoChecks({
      ...validFiles,
      adminWebSources: {
        'apps/admin-web/src/components/Leak.tsx': [
          "import { PrismaClient } from '@prisma/client'",
          'export function Leak() { return null }',
        ].join('\n'),
        'apps/admin-web/src/features/overview/overview.functions.ts': [
          "import { createServerFn } from '@tanstack/react-start'",
          'export const mutate = createServerFn().handler(() => prisma.botAgentGoal.update({}))',
        ].join('\n'),
      },
    } as Parameters<typeof runRepoChecks>[0] & {
      adminWebSources: Record<string, string>
    })

    assert.match(result.errors.join('\n'), /apps\/admin-web\/src\/components\/Leak\.tsx/)
    assert.match(result.errors.join('\n'), /@prisma\/client/)
    assert.match(result.errors.join('\n'), /apps\/admin-web\/src\/features\/overview\/overview\.functions\.ts/)
    assert.match(result.errors.join('\n'), /\.update\(/)
  })

  test('allows only the fixed operations server mutation boundary and rejects generic execution', () => {
    const allowed = runRepoChecks({
      ...validFiles,
      adminWebSources: {
        'apps/admin-web/src/features/operations/operations.server.ts': [
          "import '@tanstack/react-start/server-only'",
          "import { createHash } from 'node:crypto'",
          'const fingerprint = createHash(\'sha256\').update(\'preview\').digest(\'hex\')',
          'export async function run() { return resetAgentState({ scope: \'context\' }) }',
        ].join('\n'),
      },
    })
    const rejected = runRepoChecks({
      ...validFiles,
      adminWebSources: {
        'apps/admin-web/src/features/operations/operations.server.ts': [
          "import '@tanstack/react-start/server-only'",
          "import { execFile } from 'node:child_process'",
          'export async function run() { return prisma.$executeRaw(\'DELETE\') }',
        ].join('\n'),
      },
    })

    assert.deepEqual(allowed.errors, [])
    assert.match(rejected.errors.join('\n'), /node:child_process/)
    assert.match(rejected.errors.join('\n'), /\$executeRaw/)
  })

  test('requires append-only agent ledger models and rejects legacy snapshot models', () => {
    const result = runRepoChecks({
      ...validFiles,
      'prisma/schema.prisma': [
        'model BotAgentSnapshot {',
        '  @@map("bot_agent_snapshot")',
        '}',
        'model BotAgentSnapshotCheckpoint {',
        '  @@map("bot_agent_snapshot_checkpoints")',
        '}',
      ].join('\n'),
    })

    assert.match(result.errors.join('\n'), /BotAgentLedgerEntry.*bot_agent_ledger_entries/)
    assert.match(result.errors.join('\n'), /BotAgentRuntimeState.*bot_agent_runtime_state/)
    assert.match(result.errors.join('\n'), /BotAgentCheckpoint.*bot_agent_checkpoint/)
    assert.match(result.errors.join('\n'), /must not define legacy model BotAgentSnapshot/)
    assert.match(result.errors.join('\n'), /must not define legacy model BotAgentSnapshotCheckpoint/)
  })

  test('rejects stale README references to removed architecture surfaces', () => {
    const result = runRepoChecks({
      ...validFiles,
      'README.md': 'Use scene_agent_contexts and reply_records in admin-web.',
    })

    assert.match(result.errors.join('\n'), /README\.md references removed surface "scene_agent_contexts"/)
    assert.match(result.errors.join('\n'), /README\.md references removed surface "reply_records"/)
    assert.doesNotMatch(result.errors.join('\n'), /README\.md references removed surface "admin-web"/)
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
        '`help` `invoke` `pause` `send_message` `generate_image` `background_task` `memory` `workspace_bash` `workspace_file` `browser` `web_search`',
        '`help` `db` `style` `openbb` `fetch` `metrics` `collect_sticker`',
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
        '`help` `invoke` `pause` `send_message` `generate_image` `background_task` `memory` `collect_sticker` `workspace_bash` `workspace_file` `browser` `web_search`',
        '`help` `db` `style` `openbb` `fetch` `metrics`',
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
    assert.match(result.errors.join('\n'), /package\.json must define scripts\["agent:daily-metrics"\]/)
    assert.match(result.errors.join('\n'), /package\.json must define scripts\["agent:memory-check"\]/)
  })

  test('requires the scoped state reset command and rejects its destructive legacy name', () => {
    const packageJson = JSON.parse(validFiles['package.json'])
    delete packageJson.scripts['agent:reset-state']
    packageJson.scripts['agent:reset-memory'] = 'tsx scripts/reset-agent-memory.ts --confirm'

    const result = runRepoChecks({
      ...validFiles,
      'package.json': JSON.stringify(packageJson),
    })

    assert.match(result.errors.join('\n'), /scripts\["agent:reset-state"\]/)
    assert.match(result.errors.join('\n'), /must not define legacy scripts\["agent:reset-memory"\]/)
  })

  test('rejects missing memory architecture recovery and untrusted-data contracts', () => {
    const result = runRepoChecks({
      ...validFiles,
      'docs/MEMORY_ARCHITECTURE.md': '# Memory\nSQLite index\n',
    })

    assert.match(result.errors.join('\n'), /docs\/MEMORY_ARCHITECTURE\.md must document Markdown as the source of truth/)
    assert.match(result.errors.join('\n'), /docs\/MEMORY_ARCHITECTURE\.md must document checkpoint recovery/)
    assert.match(result.errors.join('\n'), /docs\/MEMORY_ARCHITECTURE\.md must document auxiliary LLM input as untrusted data/)
  })

  test('rejects stale README environment variable names', () => {
    const result = runRepoChecks({
      ...validFiles,
      'README.md': 'Configure `GROUP_IDS` before startup. Uses `bot_agent_ledger_entries`.',
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
      'prompts/system/system.md': '- workspace_bash: 日记/梦境用 `journal write|list|search|read`.\n',
    })

    assert.match(result.errors.join('\n'), /docs\/TOOLS\.md must mention registered tool "generate_image"/)
    assert.match(result.errors.join('\n'), /docs\/TOOLS\.md must mention workspace_bash subcommand "help"/)
    assert.match(result.errors.join('\n'), /prompts\/system\/system\.md must mention workspace_bash subcommand "help"/)
  })

  test('rejects legacy prompt files left behind after directory migration', () => {
    const result = runRepoChecks({
      ...validFiles,
      'prompts/bot-style.md': 'legacy',
    })

    assert.match(result.errors.join('\n'), /must not keep legacy prompt file/)
  })

  test('rejects section markers in standalone prompt files', () => {
    const result = runRepoChecks({
      ...validFiles,
      'prompts/chat-style/base.md': '<!-- section:style_base -->\n全局说话风格。\n',
    })

    assert.match(result.errors.join('\n'), /standalone prompt files must not contain section markers/)
  })

  test('rejects an unbracketed complete style topic enum in the resident system prompt', () => {
    const result = runRepoChecks({
      ...validFiles,
      'prompts/system/system.md': validFiles['prompts/system/system.md'].replace(
        '`style global`',
        '`style global constraints|base|anti_patterns|roleplay|nsfw`',
      ),
    })

    assert.match(result.errors.join('\n'), /must not enumerate all style topics/)
  })

  test('rejects a reordered complete style topic enum in the resident system prompt', () => {
    const result = runRepoChecks({
      ...validFiles,
      'prompts/system/system.md': validFiles['prompts/system/system.md'].replace(
        '`style global`',
        '`style global roleplay|constraints|base|anti_patterns|nsfw`',
      ),
    })

    assert.match(result.errors.join('\n'), /must not enumerate all style topics/)
  })

  test('allows partial style topic hints on the style global route', () => {
    const result = runRepoChecks({
      ...validFiles,
      'prompts/system/system.md': validFiles['prompts/system/system.md'].replace(
        '`style global`',
        '`style global constraints|base`',
      ),
    })

    assert.deepEqual(result.errors, [])
  })

  test('rejects a complete style topic enum split across resident system prompt lines', () => {
    const result = runRepoChecks({
      ...validFiles,
      'prompts/system/system.md': validFiles['prompts/system/system.md'].replace(
        '`style global` / `style group <groupId>`',
        '`style global` 或 `style group <groupId>`\n可选主题：constraints | base | anti_patterns | roleplay | nsfw',
      ),
    })

    assert.match(result.errors.join('\n'), /must not enumerate all style topics/)
  })

  test('rejects missing test and observability env markers', () => {
    const result = runRepoChecks({
      ...validFiles,
      '.env.example': '# no observability markers\n',
    })

    assert.match(result.errors.join('\n'), /.env\.example must mention BOT_EVENT_DEBOUNCE_MS/)
    assert.match(result.errors.join('\n'), /.env\.example must mention BOT_TOKEN_USAGE_LOG_PATH/)
    assert.match(result.errors.join('\n'), /.env\.example must mention BOT_OBSERVABILITY_RETENTION_DAYS/)
  })

  test('rejects an invalid Markdown group policy document', () => {
    const result = runRepoChecks({
      ...validFiles,
      'prompts/groups.md': '# 群聊配置\n',
    })

    assert.match(result.errors.join('\n'), /prompts\/groups\.md must define readable group participation policies/)
  })

  test('rejects stale group env configuration', () => {
    const result = runRepoChecks({
      ...validFiles,
      '.env.example': [
        'BOT_EVENT_DEBOUNCE_MS=3000',
        'BOT_TOKEN_USAGE_LOG_PATH=logs/token-usage.ndjson',
        'BOT_GROUP_AMBIENT_SEND_IDS=111',
      ].join('\n'),
    })

    assert.match(result.errors.join('\n'), /must not mention stale group config BOT_GROUP_AMBIENT_SEND_IDS/)
  })
})
