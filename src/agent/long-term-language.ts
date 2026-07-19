export const CHINESE_NARRATIVE_ERROR =
  '长期状态的人类可读叙述必须以中文为载体；命令、路径、URL、API 名和专有名词可以保留原文，但请用中文说明它们。'

const HAN_SCRIPT_REGEX = /\p{Script=Han}/u
const HAN_SCRIPT_GLOBAL_REGEX = /\p{Script=Han}/gu
const LATIN_WORD_REGEX = /\b[A-Za-z][A-Za-z'-]*\b/g
const FENCED_CODE_REGEX = /```[\s\S]*?```/g
const INLINE_CODE_REGEX = /`[^`\n]+`/g
const URL_REGEX = /https?:\/\/\S+/g

/**
 * 长期状态允许夹带代码、命令、路径和专有名词，但必须存在中文叙述载体。
 * 这里只做确定性的最低门槛；完整表达规则仍由 prompt / tool description 约束。
 */
export function hasChineseNarrative(value: string): boolean {
  const prose = value
    .replace(FENCED_CODE_REGEX, '')
    .replace(INLINE_CODE_REGEX, '')
    .replace(URL_REGEX, '')
  if (!HAN_SCRIPT_REGEX.test(prose)) return false

  for (const line of prose.split('\n')) {
    const latinWords = line.match(LATIN_WORD_REGEX)?.length ?? 0
    if (latinWords < 6) continue
    const hanChars = line.match(HAN_SCRIPT_GLOBAL_REGEX)?.length ?? 0
    if (hanChars < latinWords) return false
  }
  return true
}
