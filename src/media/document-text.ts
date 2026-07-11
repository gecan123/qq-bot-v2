import { inflateRawSync } from 'node:zlib'

export type DocumentFileType = 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'rtf'

const MAX_ZIP_ENTRIES = 2_000
const MAX_EXTRACTED_BYTES = 20 * 1024 * 1024

export function extractDocumentText(data: Uint8Array, fileType: DocumentFileType): string {
  if (fileType === 'rtf') return extractRtfText(Buffer.from(data).toString('latin1'))

  const entries = readZipEntries(data)
  if (fileType === 'docx') return extractDocx(entries)
  if (fileType === 'pptx') return extractPptx(entries)
  if (fileType === 'xlsx') return extractXlsx(entries)
  return extractOdf(entries)
}

function readZipEntries(data: Uint8Array): Map<string, Buffer> {
  const input = Buffer.from(data)
  const eocd = findSignatureBackwards(input, 0x06054b50)
  if (eocd < 0 || eocd + 22 > input.length) throw new Error('无效的 ZIP/Office 文档: 找不到 central directory')

  const entryCount = input.readUInt16LE(eocd + 10)
  const centralOffset = input.readUInt32LE(eocd + 16)
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error(`文档内文件数超过上限 ${MAX_ZIP_ENTRIES}`)

  const output = new Map<string, Buffer>()
  let offset = centralOffset
  let extractedBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > input.length || input.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('无效的 ZIP/Office 文档: central directory 损坏')
    }
    const compression = input.readUInt16LE(offset + 10)
    const compressedSize = input.readUInt32LE(offset + 20)
    const uncompressedSize = input.readUInt32LE(offset + 24)
    const nameLength = input.readUInt16LE(offset + 28)
    const extraLength = input.readUInt16LE(offset + 30)
    const commentLength = input.readUInt16LE(offset + 32)
    const localOffset = input.readUInt32LE(offset + 42)
    const name = input.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength

    if (!wantedXmlEntry(name)) continue
    if (uncompressedSize > MAX_EXTRACTED_BYTES || extractedBytes + uncompressedSize > MAX_EXTRACTED_BYTES) {
      throw new Error('Office 文档解压后的 XML 超过安全上限')
    }
    if (localOffset + 30 > input.length || input.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('无效的 ZIP/Office 文档: local entry 损坏')
    }
    const localNameLength = input.readUInt16LE(localOffset + 26)
    const localExtraLength = input.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + compressedSize > input.length) {
      throw new Error('无效的 ZIP/Office 文档: entry 数据越界')
    }
    const compressed = input.subarray(dataStart, dataStart + compressedSize)
    let content: Buffer
    if (compression === 0) content = Buffer.from(compressed)
    else if (compression === 8) content = inflateRawSync(compressed, { maxOutputLength: MAX_EXTRACTED_BYTES })
    else throw new Error(`不支持的 Office ZIP 压缩方法: ${compression}`)
    extractedBytes += content.length
    output.set(name, content)
  }
  return output
}

function wantedXmlEntry(name: string): boolean {
  return name === 'content.xml' ||
    /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(name) ||
    /^ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name) ||
    name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
}

function findSignatureBackwards(data: Buffer, signature: number): number {
  for (let offset = Math.max(0, data.length - 65_557); offset <= data.length - 4; offset += 1) {
    const candidate = data.length - 4 - (offset - Math.max(0, data.length - 65_557))
    if (data.readUInt32LE(candidate) === signature) return candidate
  }
  return -1
}

function extractDocx(entries: ReadonlyMap<string, Buffer>): string {
  const names = [...entries.keys()]
    .filter((name) => name.startsWith('word/'))
    .sort((a, b) => documentPartOrder(a) - documentPartOrder(b) || a.localeCompare(b))
  if (!names.includes('word/document.xml')) throw new Error('DOCX 缺少 word/document.xml')
  return normalizeText(names.map((name) => xmlToText(entries.get(name)!.toString('utf8'))).join('\n'))
}

function documentPartOrder(name: string): number {
  if (name === 'word/document.xml') return 0
  if (name.includes('header')) return 1
  if (name.includes('footer')) return 2
  return 3
}

function extractPptx(entries: ReadonlyMap<string, Buffer>): string {
  const slides = numberedEntries(entries, /^ppt\/slides\/slide(\d+)\.xml$/)
  if (slides.length === 0) throw new Error('PPTX 中没有可读 slide')
  return normalizeText(slides.map(([_name, xml], index) => {
    const text = xmlToText(xml.toString('utf8'))
    return `幻灯片 ${index + 1}\n${text}`
  }).join('\n\n'))
}

function extractXlsx(entries: ReadonlyMap<string, Buffer>): string {
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') ?? ''
  const sharedStrings = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((match) => xmlInlineText(match[1] ?? ''))
  const sheets = numberedEntries(entries, /^xl\/worksheets\/sheet(\d+)\.xml$/)
  if (sheets.length === 0) throw new Error('XLSX 中没有可读 worksheet')

  return normalizeText(sheets.map(([_name, data], sheetIndex) => {
    const xml = data.toString('utf8')
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((rowMatch) => {
      const rowXml = rowMatch[1] ?? ''
      return [...rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cellMatch) => {
        const attrs = cellMatch[1] ?? ''
        const body = cellMatch[2] ?? ''
        const value = firstXmlValue(body, 'v')
        if (/\bt="s"/.test(attrs)) return sharedStrings[Number(value)] ?? ''
        if (/\bt="inlineStr"/.test(attrs) || /\bt="str"/.test(attrs)) return xmlInlineText(body)
        return decodeXml(value)
      }).join('\t').replace(/\t+$/g, '')
    })
    return `工作表 ${sheetIndex + 1}\n${rows.join('\n')}`
  }).join('\n\n'))
}

function extractOdf(entries: ReadonlyMap<string, Buffer>): string {
  const content = entries.get('content.xml')
  if (!content) throw new Error('OpenDocument 缺少 content.xml')
  return normalizeText(xmlToText(content.toString('utf8')))
}

function numberedEntries(
  entries: ReadonlyMap<string, Buffer>,
  pattern: RegExp,
): Array<[string, Buffer]> {
  return [...entries.entries()]
    .map(([name, data]) => ({ name, data, match: pattern.exec(name) }))
    .filter((item): item is { name: string; data: Buffer; match: RegExpExecArray } => item.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map(({ name, data }) => [name, data])
}

function xmlToText(xml: string): string {
  return decodeXml(xml
    .replace(/<w:tab\b[^>]*\/>|<text:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>|<text:line-break\b[^>]*\/>/g, '\n')
    .replace(/<\/(?:w:p|a:p|text:p|text:h|table:table-row)>/g, '\n')
    .replace(/<\/(?:w:tc|table:table-cell)>/g, '\t')
    .replace(/<[^>]+>/g, ''))
}

function xmlInlineText(xml: string): string {
  return normalizeText(decodeXml(xml.replace(/<[^>]+>/g, ' ')))
}

function firstXmlValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(xml)
  return match?.[1] ?? ''
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function extractRtfText(rtf: string): string {
  return normalizeText(rtf
    .replace(/\\'([0-9a-f]{2})/gi, (_match, hex: string) => Buffer.from([parseInt(hex, 16)]).toString('latin1'))
    .replace(/\\u(-?\d+)\??/g, (_match, value: string) => String.fromCodePoint((Number(value) + 65_536) % 65_536))
    .replace(/\\(?:par|line)\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/\\[{}\\]/g, (value) => value.slice(1))
    .replace(/[{}]/g, ''))
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
