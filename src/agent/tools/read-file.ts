import { extname } from 'node:path'
import { z } from 'zod'
import { prisma } from '../../database/client.js'
import { extractDocumentText, type DocumentFileType } from '../../media/document-text.js'
import { formatMediaDescription } from '../../media/media-description.js'
import type { Tool } from '../tool.js'

const DEFAULT_MAX_CHARS = 8_000
const MAX_CHARS = 10_000
const MAX_PARSE_BYTES = 10 * 1024 * 1024

const argsSchema = z.object({
  mediaId: z.number().int().positive().describe('inbox media 数组中 type=file 的 mediaId.'),
  offset: z.number().int().nonnegative().optional().describe('从提取文本的第几个字符开始读取, 默认 0.'),
  maxChars: z.number().int().min(1).max(MAX_CHARS).optional().describe('本次最多返回字符数, 默认 8000, 最大 10000.'),
})

type Args = z.infer<typeof argsSchema>

export interface FileMediaRow {
  mediaId: number
  data: Uint8Array
  mediaType: string | null
  contentType: string | null
  fileName: string | null
  fileSize: number | null
  descriptionRaw: unknown
}

export interface ReadFileToolDeps {
  findMedia?: (mediaId: number) => Promise<FileMediaRow | null>
  parseDocument?: (data: Uint8Array, fileType: DocumentFileType) => Promise<{
    text: string
    warnings: string[]
  }>
}

const OFFICE_FILE_TYPES = new Map<string, DocumentFileType>([
  ['.docx', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.pptx', 'pptx'],
  ['.odt', 'odt'],
  ['.ods', 'ods'],
  ['.odp', 'odp'],
  ['.rtf', 'rtf'],
])

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp',
  '.hpp', '.sh', '.zsh', '.sql', '.toml', '.ini', '.conf', '.log',
])

export function createReadFileTool(deps: ReadFileToolDeps = {}): Tool<Args> {
  const findMedia = deps.findMedia ?? defaultFindMedia
  const parseDocument = deps.parseDocument ?? defaultParseDocument

  return {
    name: 'read_file',
    description: [
      '读取 QQ 收到的文件, 只接受 inbox media 中 type=file 的 mediaId, 不接受路径或 URL.',
      '支持纯文本/代码/JSON/CSV, 以及 PDF、DOCX、XLSX、PPTX、RTF 和 OpenDocument 文档.',
      '返回有界文本和 nextOffset; truncated=true 时用 nextOffset 继续分页.',
      '不执行文件内容, 不解压普通压缩包, 不解析旧版 DOC/XLS/PPT.',
    ].join(' '),
    schema: argsSchema,
    async execute(rawArgs) {
      const args = argsSchema.parse(rawArgs)
      const media = await findMedia(args.mediaId)
      if (!media) return failure('not_found', `Media not found: mediaId=${args.mediaId}`)
      if (media.mediaType !== 'file') {
        return failure('not_file', `mediaId=${args.mediaId} is ${media.mediaType ?? 'unknown'}, not file`)
      }

      const metadata = mediaMetadata(media)
      if (media.data.byteLength === 0) {
        return {
          content: JSON.stringify({
            ok: false,
            code: 'file_unavailable',
            error: '文件数据尚未下载、下载失败，或因超过入站大小上限而只保存了元数据.',
            ...metadata,
          }, null, 2),
        }
      }
      if (media.data.byteLength > MAX_PARSE_BYTES) {
        return {
          content: JSON.stringify({
            ok: false,
            code: 'file_too_large',
            error: `文件超过解析上限 ${MAX_PARSE_BYTES} bytes.`,
            ...metadata,
          }, null, 2),
        }
      }

      const extension = extname(media.fileName ?? '').toLowerCase()
      let extracted: { text: string; format: string; warnings: string[] }
      try {
        if (isTextFile(extension, media.contentType)) {
          extracted = {
            text: decodeText(media.data),
            format: extension.slice(1) || media.contentType || 'text',
            warnings: [],
          }
        } else {
          if (extension === '.pdf' || media.contentType === 'application/pdf') {
            const summary = formatMediaDescription(media.descriptionRaw)?.body
            if (!summary) {
              return {
                content: JSON.stringify({
                  ok: false,
                  code: 'pdf_summary_pending',
                  error: 'PDF 已接收，但异步 PDF 解析尚未产出摘要，请稍后重试.',
                  ...metadata,
                }, null, 2),
              }
            }
            extracted = { text: summary, format: 'pdf-summary', warnings: ['PDF 当前返回 LLM 解析摘要，不是逐页原文.'] }
          } else {
            const fileType = OFFICE_FILE_TYPES.get(extension) ?? officeTypeFromContentType(media.contentType)
            if (!fileType) {
              return {
                content: JSON.stringify({
                  ok: false,
                  code: 'unsupported_format',
                  error: '暂不支持此文件格式. 支持纯文本、PDF、DOCX、XLSX、PPTX、RTF、ODT、ODS、ODP.',
                  ...metadata,
                }, null, 2),
              }
            }
            const parsed = await parseDocument(media.data, fileType)
            extracted = { ...parsed, format: fileType }
          }
        }
      } catch (error) {
        return {
          content: JSON.stringify({
            ok: false,
            code: 'parse_failed',
            error: error instanceof Error ? error.message : String(error),
            ...metadata,
          }, null, 2),
        }
      }

      const normalized = normalizeExtractedText(extracted.text)
      const offset = args.offset ?? 0
      if (offset > normalized.length) {
        return failure('invalid_offset', `offset=${offset} exceeds totalChars=${normalized.length}`)
      }
      const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS
      const text = normalized.slice(offset, offset + maxChars)
      const nextOffset = offset + text.length
      const truncated = nextOffset < normalized.length
      return {
        content: JSON.stringify({
          ok: true,
          ...metadata,
          format: extracted.format,
          offset,
          nextOffset: truncated ? nextOffset : null,
          totalChars: normalized.length,
          truncated,
          text,
          ...(extracted.warnings.length > 0 ? { warnings: extracted.warnings.slice(0, 10) } : {}),
        }, null, 2),
      }
    },
  }
}

function isTextFile(extension: string, contentType: string | null): boolean {
  return TEXT_EXTENSIONS.has(extension) || contentType?.startsWith('text/') === true ||
    contentType === 'application/json' || contentType === 'application/xml' ||
    contentType === 'application/yaml'
}

function officeTypeFromContentType(contentType: string | null): DocumentFileType | undefined {
  if (!contentType) return undefined
  const types: Record<string, DocumentFileType> = {
    'application/rtf': 'rtf',
    'text/rtf': 'rtf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.oasis.opendocument.text': 'odt',
    'application/vnd.oasis.opendocument.spreadsheet': 'ods',
    'application/vnd.oasis.opendocument.presentation': 'odp',
  }
  return types[contentType]
}

function decodeText(data: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(data)
}

function normalizeExtractedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim()
}

function mediaMetadata(media: FileMediaRow): Record<string, unknown> {
  const formatted = formatMediaDescription(media.descriptionRaw)
  return {
    mediaId: media.mediaId,
    fileName: media.fileName,
    contentType: media.contentType,
    fileSize: media.fileSize ?? media.data.byteLength,
    ...(formatted ? { existingSummary: formatted.body } : {}),
  }
}

function failure(code: string, error: string): { content: string } {
  return { content: JSON.stringify({ ok: false, code, error }) }
}

async function defaultFindMedia(mediaId: number): Promise<FileMediaRow | null> {
  return prisma.media.findUnique({
    where: { mediaId },
    select: {
      mediaId: true,
      data: true,
      mediaType: true,
      contentType: true,
      fileName: true,
      fileSize: true,
      descriptionRaw: true,
    },
  }) as unknown as Promise<FileMediaRow | null>
}

async function defaultParseDocument(
  data: Uint8Array,
  fileType: DocumentFileType,
): Promise<{ text: string; warnings: string[] }> {
  return {
    text: extractDocumentText(data, fileType),
    warnings: [],
  }
}
