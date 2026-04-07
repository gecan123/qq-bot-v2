import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { segmentsToPlainText } from './segment-text.js'
import type { ParsedSegment } from '../types/message-segments.js'

describe('segmentsToPlainText', () => {
  test('text segment returns content', () => {
    const segments: ParsedSegment[] = [{ type: 'text', content: 'hello world' }]
    assert.equal(segmentsToPlainText(segments), 'hello world')
  })

  test('image segment without summary returns [图片]', () => {
    const segments: ParsedSegment[] = [{ type: 'image' }]
    assert.equal(segmentsToPlainText(segments), '[图片]')
  })

  test('image segment with mediaDescription includes derived text', () => {
    const segments: ParsedSegment[] = [{ type: 'image', mediaDescription: { summary: '一只猫' } }]
    assert.equal(segmentsToPlainText(segments), '[图片: 一只猫]')
  })

  test('video segment without description returns [视频]', () => {
    const segments: ParsedSegment[] = [{ type: 'video' }]
    assert.equal(segmentsToPlainText(segments), '[视频]')
  })

  test('video segment with mediaDescription includes it', () => {
    const segments: ParsedSegment[] = [{ type: 'video', mediaDescription: { description: '搞笑片段' } }]
    assert.equal(segmentsToPlainText(segments), '[视频: 搞笑片段]')
  })

  test('record segment without description returns [语音]', () => {
    const segments: ParsedSegment[] = [{ type: 'record' }]
    assert.equal(segmentsToPlainText(segments), '[语音]')
  })

  test('record segment with mediaDescription includes it', () => {
    const segments: ParsedSegment[] = [{ type: 'record', mediaDescription: { transcription: '语音内容' } }]
    assert.equal(segmentsToPlainText(segments), '[语音: 语音内容]')
  })

  test('file segment without fileName returns [文件]', () => {
    const segments: ParsedSegment[] = [{ type: 'file' }]
    assert.equal(segmentsToPlainText(segments), '[文件]')
  })

  test('file segment with fileName includes it', () => {
    const segments: ParsedSegment[] = [{ type: 'file', fileName: 'report.pdf' }]
    assert.equal(segmentsToPlainText(segments), '[文件: report.pdf]')
  })

  test('face segment without name returns [表情]', () => {
    const segments: ParsedSegment[] = [{ type: 'face', faceId: 1 }]
    assert.equal(segmentsToPlainText(segments), '[表情]')
  })

  test('face segment with name includes it', () => {
    const segments: ParsedSegment[] = [{ type: 'face', faceId: 1, name: '笑脸' }]
    assert.equal(segmentsToPlainText(segments), '[表情: 笑脸]')
  })

  test('at segment uses targetName when available', () => {
    const segments: ParsedSegment[] = [{ type: 'at', targetId: '123', targetName: '小明' }]
    assert.equal(segmentsToPlainText(segments), '@小明')
  })

  test('at segment falls back to targetId', () => {
    const segments: ParsedSegment[] = [{ type: 'at', targetId: '456' }]
    assert.equal(segmentsToPlainText(segments), '@456')
  })

  test('reply segment returns empty string', () => {
    const segments: ParsedSegment[] = [{ type: 'reply', messageId: '999' }]
    assert.equal(segmentsToPlainText(segments), '')
  })

  test('raw segment returns type in brackets', () => {
    const segments: ParsedSegment[] = [{ type: 'raw', originalType: 'location', data: {} }]
    assert.equal(segmentsToPlainText(segments), '[location]')
  })

  test('multiple segments are concatenated', () => {
    const segments: ParsedSegment[] = [
      { type: 'at', targetId: '123', targetName: '小明' },
      { type: 'text', content: ' 你好' },
    ]
    assert.equal(segmentsToPlainText(segments), '@小明 你好')
  })

  test('empty segments array returns empty string', () => {
    assert.equal(segmentsToPlainText([]), '')
  })

  test('trims whitespace', () => {
    const segments: ParsedSegment[] = [{ type: 'text', content: '  hello  ' }]
    assert.equal(segmentsToPlainText(segments), 'hello')
  })
})
