# Prompt Directory Organization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把多 section 提示词迁移为“一文件一加载单元”的目录结构，并把模糊的 `special_cases` 拆成明确的 `roleplay` 与 `nsfw` 主题。

**Architecture:** `prompts/system/` 保存三个常驻 system prompt 组成单元，`prompts/chat-style/` 保存按需聊天规则卡片。读取方统一使用现有 `loadPrompt()` 读取完整文件；不增加旧路径或旧 section 兼容层，不改变 ledger、replay、compaction、runtime state 或工具结果格式。

**Tech Stack:** Markdown prompts、TypeScript、Zod、Node.js test runner、pnpm

---

### Task 1: 拆分 chat-style 文件与 typed tool

**Files:**
- Create: `prompts/chat-style/index.md`
- Create: `prompts/chat-style/constraints.md`
- Create: `prompts/chat-style/base.md`
- Create: `prompts/chat-style/anti-patterns.md`
- Create: `prompts/chat-style/roleplay.md`
- Create: `prompts/chat-style/nsfw.md`
- Modify: `src/agent/tools/chat-style.ts`
- Test: `src/agent/tools/chat-style.test.ts`

**Step 1: Write the failing test**

把 global 测试改成分别读取五个公开主题，并通过 schema 明确拒绝旧主题：

```ts
const roleplay = await tool.execute({ scope: 'global', section: 'roleplay' }, undefined as never)
const nsfw = await tool.execute({ scope: 'global', section: 'nsfw' }, undefined as never)

assert.match(index.content as string, /roleplay/)
assert.match(index.content as string, /nsfw/)
assert.doesNotMatch(index.content as string, /special_cases|section:/)
assert.match(roleplay.content as string, /角色扮演、cosplay/)
assert.doesNotMatch(roleplay.content as string, /NSFW|色情|黄段子/)
assert.match(nsfw.content as string, /NSFW/)
assert.doesNotMatch(nsfw.content as string, /角色扮演、cosplay/)
assert.equal(tool.schema.safeParse({ scope: 'global', section: 'special_cases' }).success, false)
```

继续保留现有的职责断言：constraints 拥有 500 字硬边界、base 服从 participation、anti-patterns 拥有运维术语反例。

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/chat-style.test.ts
```

Expected: FAIL，因为当前 schema 不接受 `roleplay` / `nsfw`，且仍只有 `special_cases`。

**Step 3: Create the six prompt cards**

用 `apply_patch` 从现有三个 prompt 文件迁移正文：

- `index.md` 改成普通索引文档，列出 `constraints`、`base`、`anti_patterns`、`roleplay`、`nsfw`，不再提 `style_index section`。
- `constraints.md` 完整迁移 `chat_constraints` 正文。
- `base.md`、`anti-patterns.md` 完整迁移各自 section 正文。
- 把原 `special_cases` 中角色扮演段落放入 `roleplay.md`，NSFW 段落放入 `nsfw.md`。
- 所有新文件都禁止出现 `<!-- section:` marker。

**Step 4: Point chat_style at full files**

把 `chat-style.ts` 改为：

```ts
import { loadPrompt } from '../../config/prompt-loader.js'

const STYLE_PROMPT_PATHS = {
  constraints: './prompts/chat-style/constraints.md',
  base: './prompts/chat-style/base.md',
  anti_patterns: './prompts/chat-style/anti-patterns.md',
  roleplay: './prompts/chat-style/roleplay.md',
  nsfw: './prompts/chat-style/nsfw.md',
} as const

const GLOBAL_STYLE_SECTIONS = ['constraints', 'base', 'anti_patterns', 'roleplay', 'nsfw'] as const
```

global schema 使用 `z.enum(GLOBAL_STYLE_SECTIONS)`；不传 section 时 `loadPrompt('./prompts/chat-style/index.md')`，传入时直接 `loadPrompt(STYLE_PROMPT_PATHS[args.section])`。

**Step 5: Run test to verify it passes**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/chat-style.test.ts
```

Expected: 3 tests PASS。

**Step 6: Commit**

```bash
git add prompts/chat-style src/agent/tools/chat-style.ts src/agent/tools/chat-style.test.ts
git commit -m "refactor: 拆分聊天风格提示词"
```

### Task 2: 更新 workspace_bash 风格路由

**Files:**
- Modify: `src/agent/tools/workspace-bash.ts`
- Test: `src/agent/tools/workspace-bash.test.ts`

**Step 1: Write the failing parser and routing tests**

在 parser 测试中加入：

```ts
assert.deepEqual(parseWorkspaceBashCommand('style global roleplay'), {
  ok: true,
  kind: 'style',
  cwd: 'workspace',
  scope: 'global',
  section: 'roleplay',
})
assert.deepEqual(parseWorkspaceBashCommand('style global nsfw'), {
  ok: true,
  kind: 'style',
  cwd: 'workspace',
  scope: 'global',
  section: 'nsfw',
})
assert.equal(parseWorkspaceBashCommand('style global special_cases').ok, false)
```

在 tool 测试中执行 `style global roleplay` 和 `style global nsfw`，断言内容互不串位；help/description 断言新主题存在、旧主题不存在。

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/workspace-bash.test.ts
```

Expected: FAIL，parser 和帮助文本仍只认识 `special_cases`。

**Step 3: Update the route type and allowlist**

把 `ParsedStyleCommand.section` 与 `parseStyleCommand()` allowlist 更新为：

```ts
section?: 'constraints' | 'base' | 'anti_patterns' | 'roleplay' | 'nsfw'
```

错误信息、`help style` 命令列表和 workspace_bash description 全部使用：

```text
style global [constraints|base|anti_patterns|roleplay|nsfw]
```

不要保留 `special_cases` 分支或兼容映射。

**Step 4: Run focused tests**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/tools/chat-style.test.ts src/agent/tools/workspace-bash.test.ts
```

Expected: 全部 PASS。

**Step 5: Commit**

```bash
git add src/agent/tools/workspace-bash.ts src/agent/tools/workspace-bash.test.ts
git commit -m "refactor: 更新风格主题路由"
```

### Task 3: 拆分常驻 system prompt 加载单元

**Files:**
- Create: `prompts/system/system.md`
- Create: `prompts/system/persona.md`
- Create: `prompts/system/owner.md`
- Modify: `src/agent/bot-system-prompt.ts`
- Test: `src/agent/bot-system-prompt.test.ts`

**Step 1: Write the failing structure test**

在 system prompt 测试中读取三个目标文件，并锁定文件边界与渲染语义：

```ts
const systemSource = readFileSync('prompts/system/system.md', 'utf8')
const personaSource = readFileSync('prompts/system/persona.md', 'utf8')
const ownerSource = readFileSync('prompts/system/owner.md', 'utf8')

for (const source of [systemSource, personaSource, ownerSource]) {
  assert.doesNotMatch(source, /<!--\s*\/?section:/)
}

assert.match(systemSource, /\{\{ownerSection\}\}.*\{\{persona\}\}/s)
assert.match(personaSource, /你是 Luna/)
assert.match(ownerSource, /\{\{ownerQq\}\}.*\{\{ownerName\}\}/s)
```

对渲染后的 prompt 增加：

```ts
assert.match(prompt, /风格.*索引/s)
assert.doesNotMatch(prompt, /special_cases/)
```

现有身份、owner、来源、行动基线、预算和场景手册排除断言全部保留。

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/bot-system-prompt.test.ts
```

Expected: FAIL，目标文件尚不存在。

**Step 3: Create the three system files**

用 `apply_patch` 迁移旧 section 正文：

- `system.md` ← 原 `system` section；保留模板占位和标题顺序。
- `persona.md` ← 原 `core` section。
- `owner.md` ← 原 `owner` section。

把 system 的风格说明改成入口级描述，例如：

```text
- chat_style / style：日常短回复用当前核心语气；需要聊天硬边界、具体风格、反例或特殊场景时先读全局风格索引，再按主题读取。群体长期变化和文化用 group memory，不复制到静态提示。
```

workspace_bash 的常用路由只保留 `风格用 style global 或 style group`，不再复制完整主题 enum。

**Step 4: Update the builder**

在 `bot-system-prompt.ts` 中改用：

```ts
import { loadPrompt } from '../config/prompt-loader.js'

const SYSTEM_PROMPT_PATH = './prompts/system/system.md'
const PERSONA_PROMPT_PATH = './prompts/system/persona.md'
const OWNER_PROMPT_PATH = './prompts/system/owner.md'
```

`renderOwnerSection()`、`buildBotSystemPrompt()` 分别读取对应全文。不要改变 `renderPromptTemplate()`、source list 渲染或启动时冻结语义。

**Step 5: Run focused tests**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/agent/bot-system-prompt.test.ts
```

Expected: 全部 PASS，resident prompt 仍不超过 2,800 token。

**Step 6: Commit**

```bash
git add prompts/system src/agent/bot-system-prompt.ts src/agent/bot-system-prompt.test.ts
git commit -m "refactor: 拆分常驻系统提示词"
```

### Task 4: 迁移 repo-check、活动文档并删除旧文件

**Files:**
- Modify: `src/ops/repo-check.ts`
- Modify: `src/ops/repo-check.test.ts`
- Modify: `scripts/repo-check.ts`
- Modify: `docs/TOOLS.md`
- Delete: `prompts/bot-system.md`
- Delete: `prompts/bot-style.md`
- Delete: `prompts/bot-chat-constraints.md`
- Test: `src/ops/repo-check.test.ts`

**Step 1: Write the failing repo layout tests**

把 `validFiles` 改为新路径，并增加两组失败用例：

```ts
test('rejects legacy bundled prompt files', () => {
  const result = runRepoChecks({
    ...validFiles,
    'prompts/bot-style.md': 'legacy',
  })
  assert.match(result.errors.join('\n'), /must not keep legacy prompt file/)
})

test('rejects section markers in standalone prompt cards', () => {
  const result = runRepoChecks({
    ...validFiles,
    'prompts/chat-style/base.md': '<!-- section:style_base -->',
  })
  assert.match(result.errors.join('\n'), /standalone prompt files must not contain section markers/)
})
```

`RepoCheckFiles` 中新 prompt 路径为必填，三个旧路径为可选字段，便于在单元测试中显式检测遗留文件。

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/repo-check.test.ts
```

Expected: FAIL，repo-check 仍要求三个旧文件和 section marker。

**Step 3: Update RepoCheckFiles and prompt layout checks**

要求以下新文件存在于 `RepoCheckFiles`：

```text
prompts/system/system.md
prompts/system/persona.md
prompts/system/owner.md
prompts/chat-style/index.md
prompts/chat-style/constraints.md
prompts/chat-style/base.md
prompts/chat-style/anti-patterns.md
prompts/chat-style/roleplay.md
prompts/chat-style/nsfw.md
```

`checkPromptSplit()` 重命名为 `checkPromptLayout()`，并验证：

- index 包含五个公开主题；
- constraints 包含 `单条消息 ≤ 500 字`；
- system 包含 `style global`、`style group` 和风格索引入口，但不硬编码主题 enum；
- 所有 standalone prompt 文件不含 section marker；
- 任一旧 prompt 可选字段存在时报告遗留文件错误。

`checkToolIndexes()` 使用 `prompts/system/system.md` 检查常用 workspace_bash 入口。

**Step 4: Update the repo-check script**

`scripts/repo-check.ts` 读取九个新文件。用 `existsSync()` 只为三个旧路径填充可选内容：存在就传入内容，缺失就不传，从而让 repo-check 能明确拒绝遗留壳文件。

**Step 5: Update active documentation**

把 `docs/TOOLS.md` 的活动说明更新为新目录和新命令：

```text
聊天硬约束与风格卡片位于 prompts/chat-style/，常驻提示词位于 prompts/system/；通过 style global constraints|base|anti_patterns|roleplay|nsfw 按需读取。
```

历史 `docs/plans/**` 和 `docs/superpowers/**` 保持原样，它们记录当时事实，不做机械改写。

**Step 6: Delete the three legacy files**

用 `apply_patch` 删除：

```text
prompts/bot-system.md
prompts/bot-style.md
prompts/bot-chat-constraints.md
```

不要保留转发壳或 symlink。

**Step 7: Run repo checks**

Run:

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx src/ops/repo-check.test.ts
pnpm repo-check
git diff --check
rg -n "special_cases|bot-style\.md|bot-system\.md|bot-chat-constraints\.md" src scripts docs/TOOLS.md prompts
```

Expected: tests 和 repo-check PASS；`rg` 无输出。历史计划文档不在搜索范围内。

**Step 8: Commit**

```bash
git add src/ops/repo-check.ts src/ops/repo-check.test.ts scripts/repo-check.ts docs/TOOLS.md prompts
git commit -m "refactor: 完成提示词目录迁移"
```

### Task 5: 完整验证与独立审查

**Files:**
- Verify: `prompts/system/**`
- Verify: `prompts/chat-style/**`
- Verify: `src/agent/bot-system-prompt.ts`
- Verify: `src/agent/tools/chat-style.ts`
- Verify: `src/agent/tools/workspace-bash.ts`
- Verify: `src/ops/repo-check.ts`
- Include in final commit: `docs/plans/2026-07-20-prompt-directory-organization.md`

**Step 1: Run all focused tests**

```bash
pnpm exec tsx --test --import ./scripts/test-env.mjs --import tsx \
  src/agent/bot-system-prompt.test.ts \
  src/agent/tools/chat-style.test.ts \
  src/agent/tools/workspace-bash.test.ts \
  src/ops/repo-check.test.ts
```

Expected: 0 failures。

**Step 2: Run repository gates**

```bash
pnpm repo-check
git diff --check
```

Expected: 两个命令退出码均为 0。

**Step 3: Run typecheck and classify any baseline failure**

```bash
pnpm typecheck
```

Expected target: PASS。若仍只出现仓库已知的 generated Prisma `currentCommitment` baseline 错误，记录完整错误并确认本次 diff 没有触及 schema/generated client；不得把 baseline failure 误报成本次验证通过，也不得顺手扩展范围修复。

**Step 4: Review replay and scope boundaries**

```bash
git diff --name-only da09aab..HEAD
git diff da09aab..HEAD -- docs/AGENT_CONTEXT.md prisma src/agent/agent-ledger-repo.ts src/agent/agent-ledger-projection.ts src/agent/compaction.ts
rg -n "<!--\s*section:" prompts/system prompts/chat-style
```

Expected: 第二、三个命令无输出；没有 ledger、projection、compaction、schema 或 section marker 变更。

**Step 5: Request independent review**

Use `superpowers:requesting-code-review`，要求 reviewer 检查：

- 文件边界是否与加载单元一致；
- system 拼装顺序和动态模板是否保持正确；
- 新主题在 typed tool、workspace_bash、帮助文本和文档中是否一致；
- 旧路径、旧 key 和 section marker 是否完全移除；
- replay 判断是否成立。

修复所有 Critical 和 Important 反馈，重新运行相关 RED/GREEN 与完整门禁。

**Step 6: Commit the implementation plan if still untracked**

```bash
git add docs/plans/2026-07-20-prompt-directory-organization.md
git commit -m "docs: 记录提示词目录迁移计划"
```

**Step 7: Operational handoff**

不要启动真实 Bot。交付时明确说明：部署后需要重启 Bot 才会清除 prompt-loader 进程内缓存；本次 system prompt 与工具声明变化会造成一次预期 cache miss，历史 ledger 无需迁移。
