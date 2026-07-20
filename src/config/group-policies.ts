import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const GROUP_POLICIES_PATH = './prompts/groups.md'
export const GROUP_PARTICIPATION_MODES = ['mentions', 'selective', 'active'] as const

export type GroupParticipation = (typeof GROUP_PARTICIPATION_MODES)[number]

export interface GroupPolicy {
  readonly id: number
  readonly participation: GroupParticipation
  /** active 群的稳定短定位；允许进入常驻 prompt，完整正文仍按需读取。 */
  readonly residentHint?: string
  readonly guidance: string
}

const GROUP_PARTICIPATION_MODE_SET = new Set<string>(GROUP_PARTICIPATION_MODES)
const LEVEL_TWO_HEADING_RE = /^##[ \t]+(.+?)[ \t]*$/gm
const GROUP_HEADING_RE = /^群 ([1-9]\d*)$/
const PARTICIPATION_RE = /^- participation:[ \t]*(\S+)[ \t]*$/gm
const RESIDENT_HINT_RE = /^- resident-hint:[ \t]*(.*?)[ \t]*$/gm
const MAX_RESIDENT_HINT_LENGTH = 200

/**
 * prompts/groups.md 是监听范围、发送授权、参与节奏和 operator 固定群提示的唯一来源。
 * 标题/档位/短定位走严格解析；resident-hint 只给 active 群进入常驻 prompt，
 * 其余正文原样作为 chat_style 的按需 guidance。
 */
export function parseGroupPoliciesMarkdown(
  markdown: string,
  sourceName = GROUP_POLICIES_PATH,
): readonly GroupPolicy[] {
  const normalized = markdown.replace(/\r\n?/g, '\n')
  const headings = [...normalized.matchAll(LEVEL_TWO_HEADING_RE)]
  const policies: GroupPolicy[] = []
  const seenIds = new Set<number>()

  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!
    const headingText = heading[1]!.trim()
    const groupMatch = GROUP_HEADING_RE.exec(headingText)
    if (!groupMatch) {
      throw new Error(`${sourceName} contains invalid level-two heading ${JSON.stringify(headingText)}; expected "## 群 <id>"`)
    }

    const id = Number(groupMatch[1])
    if (!Number.isSafeInteger(id)) {
      throw new Error(`${sourceName} contains unsafe group id ${JSON.stringify(groupMatch[1])}`)
    }
    if (seenIds.has(id)) {
      throw new Error(`${sourceName} contains duplicate group id ${id}`)
    }
    seenIds.add(id)

    const sectionStart = (heading.index ?? 0) + heading[0].length
    const sectionEnd = headings[index + 1]?.index ?? normalized.length
    const section = normalized.slice(sectionStart, sectionEnd).trim()
    const participationMatches = [...section.matchAll(PARTICIPATION_RE)]
    if (participationMatches.length !== 1) {
      throw new Error(`${sourceName} group ${id} must contain exactly one "- participation: <mode>" line`)
    }
    const participation = participationMatches[0]![1]!
    if (!GROUP_PARTICIPATION_MODE_SET.has(participation)) {
      throw new Error(
        `${sourceName} group ${id} participation must be one of ${GROUP_PARTICIPATION_MODES.join(', ')}`,
      )
    }

    const residentHintMatches = [...section.matchAll(RESIDENT_HINT_RE)]
    if (residentHintMatches.length > 1) {
      throw new Error(`${sourceName} group ${id} must contain at most one "- resident-hint: <text>" line`)
    }
    const residentHint = residentHintMatches[0]?.[1]?.trim()
    if (residentHint != null && residentHint.length === 0) {
      throw new Error(`${sourceName} group ${id} resident-hint must not be empty`)
    }
    if (residentHint != null && residentHint.length > MAX_RESIDENT_HINT_LENGTH) {
      throw new Error(`${sourceName} group ${id} resident-hint must be at most ${MAX_RESIDENT_HINT_LENGTH} characters`)
    }
    if (residentHint != null && participation !== 'active') {
      throw new Error(`${sourceName} group ${id} resident-hint is only allowed for active participation`)
    }

    const guidance = section
      .replace(PARTICIPATION_RE, '')
      .replace(RESIDENT_HINT_RE, '')
      .trim()
    policies.push({
      id,
      participation: participation as GroupParticipation,
      ...(residentHint ? { residentHint } : {}),
      guidance,
    })
  }

  return policies.sort((left, right) => left.id - right.id)
}

export function loadGroupPolicies(filePath = GROUP_POLICIES_PATH): readonly GroupPolicy[] {
  const resolved = resolve(filePath)
  return parseGroupPoliciesMarkdown(readFileSync(resolved, 'utf8'), resolved)
}

export function groupPolicyAllowsAmbient(
  policy: Pick<GroupPolicy, 'participation'>,
): boolean {
  return policy.participation !== 'mentions'
}
