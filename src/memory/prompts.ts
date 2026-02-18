export function buildGroupSummaryPrompt(oldSummary: string | null, formattedMessages: string): string {
  const oldSummarySection = oldSummary
    ? `你之前对这个群的了解：\n${oldSummary}\n\n`
    : ''

  return `${oldSummarySection}以下是该群最近的新消息：
${formattedMessages}

请更新你对这个群的整体印象，包括：群的氛围风格、常见话题、成员活跃规律。
保留旧印象中仍然成立的部分，补充新观察，修正已过时的描述。
用中文简洁描述，200字以内。`
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

  return `${oldProfileSection}此人最近的发言：
${formattedMessages}

请更新你对此人的印象（性格、兴趣、说话风格），并从上面的发言中挑选3-5句最能代表其说话方式的原话作为例句。
用中文描述，印象部分100字以内。

请严格返回如下 JSON 格式，不要添加任何其他内容：
{"profile": "...", "examples": ["...", "...", "..."]}`
}
