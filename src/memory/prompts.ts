import { loadPrompt } from '../config/prompt-loader.js'

function formatStoredJson(raw: string | null): string | null {
  if (!raw) return null
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function buildGroupSummaryPrompt(oldSummary: string | null, formattedMessages: string): string {
  const oldSummarySection = oldSummary
    ? `你之前对这个群的结构化了解（JSON）：\n${formatStoredJson(oldSummary)}\n\n`
    : ''

  return `${oldSummarySection}以下是该群最近的新消息：\n${formattedMessages}\n\n${loadPrompt('./prompts/memory-group-summary.md')}`
}

export function buildUserProfilePrompt(
  oldProfile: string | null,
  oldExamples: string[],
  formattedMessages: string,
): string {
  const storedProfile = formatStoredJson(oldProfile)
  const oldProfileSection =
    oldProfile
      ? `你之前对此人的结构化了解（JSON）：\n${storedProfile}\n\n旧的代表性发言：\n${oldExamples.map((e) => `- ${e}`).join('\n')}\n\n`
      : ''

  return `${oldProfileSection}此人最近的发言：\n${formattedMessages}\n\n${loadPrompt('./prompts/memory-user-profile.md')}`
}
