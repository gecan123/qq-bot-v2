import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { loadPrompt } from './prompt-loader.js'

describe('media prompts', () => {
  test('describe-image prompt includes rich media parsing guidance', () => {
    const prompt = loadPrompt('./prompts/describe-image.md')
    assert.match(prompt, /包含文字/)
    assert.match(prompt, /聊天记录|聊天截图/)
    assert.match(prompt, /表情包|贴纸/)
    assert.match(prompt, /不要编造|不清楚/)
  })

  test('transcribe-audio prompt requires faithful transcription output', () => {
    const prompt = loadPrompt('./prompts/transcribe-audio.md')
    assert.match(prompt, /准确转录/)
    assert.match(prompt, /方言/)
    assert.match(prompt, /不清楚/)
    assert.match(prompt, /不要额外解释|只输出/)
  })

  test('describe-video prompt includes timeline-style parsing guidance', () => {
    const prompt = loadPrompt('./prompts/describe-video.md')
    assert.match(prompt, /仔细观察视频后/)
    assert.match(prompt, /动作、表情、性别、大致年龄、穿着/)
    assert.match(prompt, /不要编造|看不清/)
  })

  test('describe-pdf prompt includes document summarization guidance', () => {
    const prompt = loadPrompt('./prompts/describe-pdf.md')
    assert.match(prompt, /使用 Markdown 描述这个 PDF/)
    assert.match(prompt, /不超过 2000 字|2000 字左右的大纲摘要/)
    assert.match(prompt, /不要编造|看不清/)
  })
})
