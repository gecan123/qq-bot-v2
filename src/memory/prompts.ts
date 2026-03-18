import { loadPrompt } from '../config/prompt-loader.js'

export function buildGroupSummaryPrompt(oldSummary: string | null, formattedMessages: string): string {
  const oldSummarySection = oldSummary
    ? `你之前对这个群的了解：\n${oldSummary}\n\n`
    : ''

  return `${oldSummarySection}以下是该群最近的新消息：\n${formattedMessages}\n\n${loadPrompt('./prompts/memory-group-summary.md')}`
}

export function buildUserProfilePrompt(
  oldProfile: string | null,
  oldExamples: string[],
  formattedMessages: string,
): string {
  const oldProfileSection =
    oldProfile
      ? `你之前对此人的了解：\n${oldProfile}\n\n旧的代表性发言：\n${oldExamples.map((e) => `- ${e}`).join('\n')}\n\n`
      : ''

  return `${oldProfileSection}此人最近的发言：\n${formattedMessages}\n\n${loadPrompt('./prompts/memory-user-profile.md')}`
}
