import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { DocumentFileType } from '../../media/document-text.js'
import { createReadFileTool, type FileMediaRow } from './read-file.js'

function media(overrides: Partial<FileMediaRow> = {}): FileMediaRow {
  return {
    mediaId: 42,
    data: Buffer.from('第一行\r\n第二行\0\n第三行'),
    mediaType: 'file',
    contentType: 'text/plain',
    fileName: 'notes.txt',
    fileSize: 30,
    descriptionRaw: null,
    ...overrides,
  }
}

describe('read_file tool', () => {
  test('reads received plain text with bounded pagination', async () => {
    const tool = createReadFileTool({
      async findMedia() {
        return media()
      },
    })

    const first = JSON.parse((await tool.execute({
      mediaId: 42,
      offset: 0,
      maxChars: 5,
    }, undefined as never)).content as string) as {
      ok: boolean
      text: string
      truncated: boolean
      nextOffset: number
      totalChars: number
    }

    assert.equal(first.ok, true)
    assert.equal(first.text, '第一行\n第')
    assert.equal(first.truncated, true)
    assert.equal(first.nextOffset, 5)
    assert.ok(first.totalChars > first.nextOffset)
  })

  test('parses supported office documents through the injected parser', async () => {
    const calls: DocumentFileType[] = []
    const tool = createReadFileTool({
      async findMedia() {
        return media({
          data: Buffer.from('fake-docx'),
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileName: 'report.docx',
        })
      },
      async parseDocument(_data, fileType) {
        calls.push(fileType)
        return { text: '标题\n正文', warnings: ['测试警告'] }
      },
    })

    const payload = JSON.parse((await tool.execute({ mediaId: 42 }, undefined as never)).content as string) as {
      ok: boolean
      format: string
      text: string
      warnings: string[]
    }
    assert.deepEqual(calls, ['docx'])
    assert.equal(payload.ok, true)
    assert.equal(payload.format, 'docx')
    assert.equal(payload.text, '标题\n正文')
    assert.deepEqual(payload.warnings, ['测试警告'])
  })

  test('rejects non-file handles and unsupported archives', async () => {
    const imageTool = createReadFileTool({
      async findMedia() {
        return media({ mediaType: 'image' })
      },
    })
    const imagePayload = JSON.parse((await imageTool.execute({ mediaId: 42 }, undefined as never)).content as string) as {
      code: string
    }
    assert.equal(imagePayload.code, 'not_file')

    const archiveTool = createReadFileTool({
      async findMedia() {
        return media({ fileName: 'archive.zip', contentType: 'application/zip' })
      },
    })
    const archivePayload = JSON.parse((await archiveTool.execute({ mediaId: 42 }, undefined as never)).content as string) as {
      code: string
    }
    assert.equal(archivePayload.code, 'unsupported_format')
  })

  test('reports metadata-only placeholders as unavailable', async () => {
    const tool = createReadFileTool({
      async findMedia() {
        return media({
          data: new Uint8Array(),
          fileName: 'large.pdf',
          contentType: 'application/pdf',
          fileSize: 30 * 1024 * 1024,
          descriptionRaw: { description: '文件过大，仅保存元数据' },
        })
      },
    })

    const payload = JSON.parse((await tool.execute({ mediaId: 42 }, undefined as never)).content as string) as {
      code: string
      fileName: string
      existingSummary: string
    }
    assert.equal(payload.code, 'file_unavailable')
    assert.equal(payload.fileName, 'large.pdf')
    assert.equal(payload.existingSummary, '文件过大，仅保存元数据')
  })
})
