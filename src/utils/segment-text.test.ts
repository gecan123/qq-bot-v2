import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { segmentsToPlainText } from './segment-text.js'
import type { ParsedSegment } from '../types/message-segments.js'

describe('segmentsToPlainText', () => {
  const simpleCases: Array<{
    name: string
    segments: ParsedSegment[]
    expected: string
  }> = [
    { name: 'text', segments: [{ type: 'text', content: 'hello world' }], expected: 'hello world' },
    { name: 'image fallback', segments: [{ type: 'image' }], expected: '[图片]' },
    {
      name: 'image summary',
      segments: [{ type: 'image', mediaDescription: { summary: '一只猫' } }],
      expected: '[图片: 一只猫]',
    },
    { name: 'video fallback', segments: [{ type: 'video' }], expected: '[视频]' },
    {
      name: 'video description',
      segments: [{ type: 'video', mediaDescription: { description: '搞笑片段' } }],
      expected: '[视频: 搞笑片段]',
    },
    { name: 'record fallback', segments: [{ type: 'record' }], expected: '[语音]' },
    {
      name: 'record transcription',
      segments: [{ type: 'record', mediaDescription: { transcription: '语音内容' } }],
      expected: '[语音: 语音内容]',
    },
    {
      name: 'record ignores refer flag',
      segments: [{ type: 'record', mediaDescription: { transcription: '今晚一起吃饭', refer: true } }],
      expected: '[语音: 今晚一起吃饭]',
    },
    { name: 'file fallback', segments: [{ type: 'file' }], expected: '[文件]' },
    { name: 'file name', segments: [{ type: 'file', fileName: 'report.pdf' }], expected: '[文件: report.pdf]' },
    { name: 'face fallback', segments: [{ type: 'face', faceId: 1 }], expected: '[表情]' },
    { name: 'face name', segments: [{ type: 'face', faceId: 1, name: '笑脸' }], expected: '[表情: 笑脸]' },
    { name: 'mention name', segments: [{ type: 'at', targetId: '123', targetName: '小明' }], expected: '@小明' },
    { name: 'mention id', segments: [{ type: 'at', targetId: '456' }], expected: '@456' },
    { name: 'reply omitted', segments: [{ type: 'reply', messageId: '999' }], expected: '' },
    { name: 'raw type', segments: [{ type: 'raw', originalType: 'location', data: {} }], expected: '[location]' },
    {
      name: 'concatenates segments',
      segments: [
        { type: 'at', targetId: '123', targetName: '小明' },
        { type: 'text', content: ' 你好' },
      ],
      expected: '@小明 你好',
    },
    { name: 'empty input', segments: [], expected: '' },
    { name: 'trims result', segments: [{ type: 'text', content: '  hello  ' }], expected: 'hello' },
  ]

  for (const { name, segments, expected } of simpleCases) {
    test(name, () => assert.equal(segmentsToPlainText(segments), expected))
  }

  test('image segment fuses all structured fields with detectedType label', () => {
    const segments: ParsedSegment[] = [
      {
        type: 'image',
        mediaDescription: {
          detectedType: 'sticker',
          summary: '粉色小猪贴纸',
          description: '一只粉色卡通小猪',
          extractedText: [],
          memeContext: '萌系表达',
          intentSignal: '想卖萌',
          confidence: 0.92,
        },
      },
    ]
    assert.equal(
      segmentsToPlainText(segments),
      '[图片(sticker): 一只粉色卡通小猪 | 概要:粉色小猪贴纸 | 梗:萌系表达 | 推测意图:想卖萌 | 置信度:0.92]',
    )
  })

  test('image segment skips empty fields', () => {
    const segments: ParsedSegment[] = [
      {
        type: 'image',
        mediaDescription: {
          description: '一只猫',
          summary: '',
          extractedText: [],
          memeContext: '   ',
        },
      },
    ]
    assert.equal(segmentsToPlainText(segments), '[图片: 一只猫]')
  })

  test('image segment renders OCR extractedText when description missing', () => {
    const segments: ParsedSegment[] = [
      {
        type: 'image',
        mediaDescription: {
          extractedText: ['HELLO', 'WORLD'],
          memeContext: '英文招呼',
        },
      },
    ]
    assert.equal(segmentsToPlainText(segments), '[图片: HELLO；WORLD | 梗:英文招呼]')
  })

  test('video segment fuses description, summary, extractedText with detectedType', () => {
    const segments: ParsedSegment[] = [
      {
        type: 'video',
        mediaDescription: {
          detectedType: 'screen_recording',
          description: '操作录屏',
          summary: '某 app 录屏',
          extractedText: ['登录', '继续'],
        },
      },
    ]
    assert.equal(
      segmentsToPlainText(segments),
      '[视频(screen_recording): 操作录屏 | 概要:某 app 录屏 | 文字:登录；继续]',
    )
  })

  test('file segment with PDF description renders fileName as label suffix and body inside', () => {
    const segments: ParsedSegment[] = [
      {
        type: 'file',
        fileName: 'report.pdf',
        mediaDescription: { summary: '季度财报', description: '2026 Q1 收入 $1.2M' },
      },
    ]
    assert.equal(
      segmentsToPlainText(segments),
      '[文件(report.pdf): 2026 Q1 收入 $1.2M | 概要:季度财报]',
    )
  })

  test('forward segment renders sender-labelled child messages in order', () => {
    const segments: ParsedSegment[] = [{
      type: 'forward',
      forwardId: 'forward-1',
      items: [
        {
          messageId: '11',
          senderId: '101',
          senderName: 'Alice',
          content: [{ type: 'text', content: 'hello' }],
        },
        {
          messageId: '12',
          senderId: '102',
          senderName: 'Bob',
          content: [{ type: 'image' }],
        },
      ],
    }]

    assert.equal(
      segmentsToPlainText(segments),
      '[合并转发消息]\nAlice(101): hello\nBob(102): [图片]\n[转发结束]',
    )
  })

  test('forward segment renders nested forward messages recursively', () => {
    const segments: ParsedSegment[] = [{
      type: 'forward',
      forwardId: 'outer',
      items: [{
        senderId: '101',
        senderName: 'Alice',
        content: [{
          type: 'forward',
          forwardId: 'inner',
          items: [{
            senderId: '102',
            senderName: 'Bob',
            content: [{ type: 'text', content: 'nested' }],
          }],
        }],
      }],
    }]

    assert.equal(
      segmentsToPlainText(segments),
      '[合并转发消息]\nAlice(101): [合并转发消息]\nBob(102): nested\n[转发结束]\n[转发结束]',
    )
  })

  test('forward segment discloses unavailable and truncated states', () => {
    const segments: ParsedSegment[] = [
      { type: 'forward', forwardId: 'missing', items: [], unavailable: true },
      {
        type: 'forward',
        forwardId: 'partial',
        items: [{ senderId: '103', content: [{ type: 'text', content: 'kept' }] }],
        truncated: true,
      },
    ]

    assert.equal(
      segmentsToPlainText(segments),
      '[合并转发消息: 内容不可用][合并转发消息]\n103: kept\n…（转发内容已截断）\n[转发结束]',
    )
  })

  test('caps each rendered forwarded child at two thousand characters including the ellipsis', () => {
    const segments: ParsedSegment[] = [{
      type: 'forward',
      forwardId: 'long-card',
      items: [{
        senderId: '101',
        senderName: 'Alice',
        content: [{ type: 'json_card', desc: 'x'.repeat(2_100) }],
      }],
    }]

    const childLine = segmentsToPlainText(segments).split('\n')[1]!
    const childContent = childLine.slice('Alice(101): '.length)
    assert.equal(childContent.length, 2_000)
    assert.match(childContent, /…$/)
  })
})
