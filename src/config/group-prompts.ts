import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/**
 * Per-group prompt customization (red line 5: 启动时一次 load + freeze).
 *
 * 这个 loader 只在启动期跑一次. 解析出来的 `GroupCustomization[]` 传进
 * `buildBotSystemPrompt`, 拼进同一段 system prompt 的 `[群定制]` 子段. 整段
 * prompt byte-stable; 改 yaml = bot 重启 = prompt cache 整段失效一次. 这是设计
 * 预期, 不是 bug, 保证: 同一份 yaml + 同一组运行时元数据 → 同一段 system prompt.
 *
 * fallback 语义: BOT_TARGET_GROUP_IDS 里但 yaml 里没条目的群 → 不渲染该群的
 * 特殊段, 走基础人设 (= 等价于 frequency_hint=normal + 空 body). Loader 不感
 * 知白名单, 只负责把 yaml 翻译成数据结构, 渲染层决定哪些 id 会出现在 prompt 里.
 */

export const FrequencyHintSchema = z.enum(['lurker', 'quiet', 'normal', 'chatty'])
export type FrequencyHint = z.infer<typeof FrequencyHintSchema>

export interface GroupCustomization {
  readonly id: number
  readonly frequencyHint: FrequencyHint
  readonly body: string
}

const GroupItemSchema = z.object({
  id: z.number().int(),
  frequency_hint: FrequencyHintSchema,
  body: z.string(),
})

const FileSchema = z.object({
  groups: z.array(GroupItemSchema).default([]),
})

export function loadGroupCustomizations(filePath: string): readonly GroupCustomization[] {
  const resolved = path.resolve(filePath)
  const raw = readFileSync(resolved, 'utf-8')
  const parsed = parseYaml(raw)
  // yaml 完全空文件时 parseYaml 返回 null, zod 默认 schema 接不住 (它只 .default
  // 顶层 groups 字段, 顶层是 null 时整体 fail). 这里手动把 null/undefined 当作 {}.
  const normalized = parsed == null ? {} : parsed
  const result = FileSchema.parse(normalized)
  return result.groups.map((g) => ({
    id: g.id,
    frequencyHint: g.frequency_hint,
    body: g.body,
  }))
}
