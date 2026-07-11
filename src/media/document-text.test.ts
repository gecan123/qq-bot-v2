import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { extractDocumentText } from './document-text.js'

describe('document text extraction', () => {
  test('extracts paragraphs and entities from a DOCX container', () => {
    const docx = storedZip({
      'word/document.xml': [
        '<?xml version="1.0"?>',
        '<w:document xmlns:w="w"><w:body>',
        '<w:p><w:r><w:t>标题 &amp; 摘要</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>第二段</w:t></w:r></w:p>',
        '</w:body></w:document>',
      ].join(''),
    })

    assert.equal(extractDocumentText(docx, 'docx'), '标题 & 摘要\n第二段')
  })

  test('extracts shared strings and values from XLSX worksheets', () => {
    const xlsx = storedZip({
      'xl/sharedStrings.xml': '<sst><si><t>姓名</t></si><si><t>小明</t></si></sst>',
      'xl/worksheets/sheet1.xml': [
        '<worksheet><sheetData>',
        '<row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>分数</t></is></c></row>',
        '<row><c t="s"><v>1</v></c><c><v>98</v></c></row>',
        '</sheetData></worksheet>',
      ].join(''),
    })

    assert.equal(extractDocumentText(xlsx, 'xlsx'), '工作表 1\n姓名\t分数\n小明\t98')
  })

  test('extracts basic RTF text without executing content', () => {
    assert.equal(
      extractDocumentText(Buffer.from('{\\rtf1\\ansi Hello\\par QQ file}'), 'rtf'),
      'Hello\nQQ file',
    )
  })
})

function storedZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let localOffset = 0

  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name)
    const data = Buffer.from(value)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(localOffset, 42)
    centrals.push(central, nameBytes)
    localOffset += local.length + nameBytes.length + data.length
  }

  const localData = Buffer.concat(locals)
  const centralData = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(centralData.length, 12)
  eocd.writeUInt32LE(localData.length, 16)
  return Buffer.concat([localData, centralData, eocd])
}
