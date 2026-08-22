import '@tanstack/react-start/server-only'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getRepositoryRoot } from '../../server/paths.server.js'
import {
  PROCESS_LOG_SOURCES,
  parseProcessLogTail,
  processLogSnapshotSchema,
  type ProcessLogSnapshot,
  type ProcessLogSource,
} from './logs.js'

const MAX_TAIL_BYTES = 512 * 1024
const MAX_TAIL_LINES = 500
const SOURCE_LABELS: Record<ProcessLogSource, string> = {
  'agent-core': 'Agent Core',
  'qq-gateway': 'QQ Gateway',
  'media-worker': 'Media Worker',
  'browser-controller': 'Browser Controller',
  'web-admin': 'WebAdmin',
}

export async function loadProcessLogSnapshot(
  selectedSource: ProcessLogSource,
  now = new Date(),
  repositoryRoot = getRepositoryRoot(),
): Promise<ProcessLogSnapshot> {
  const processLogRoot = join(repositoryRoot, 'logs', 'processes')
  const sources = await Promise.all(PROCESS_LOG_SOURCES.map(async id => {
    try {
      const metadata = await stat(join(processLogRoot, `${id}.log`))
      return {
        id,
        label: SOURCE_LABELS[id],
        exists: metadata.isFile(),
        sizeBytes: metadata.isFile() ? metadata.size : 0,
        updatedAt: metadata.isFile() ? metadata.mtime.toISOString() : null,
      }
    } catch {
      return { id, label: SOURCE_LABELS[id], exists: false, sizeBytes: 0, updatedAt: null }
    }
  }))

  const selected = sources.find(source => source.id === selectedSource)!
  if (!selected.exists) {
    return processLogSnapshotSchema.parse({
      schemaVersion: 2,
      generatedAt: now.toISOString(),
      selectedSource,
      sources,
      entries: [],
      bytesTruncated: false,
      lineLimitTruncated: false,
      warnings: [`${selected.label} 日志尚未生成；对应进程可能还没有启动。`],
    })
  }

  try {
    const bytesToRead = Math.min(selected.sizeBytes, MAX_TAIL_BYTES)
    const offset = Math.max(0, selected.sizeBytes - bytesToRead)
    const handle = await open(join(processLogRoot, `${selectedSource}.log`), 'r')
    let content: string
    try {
      const buffer = Buffer.alloc(bytesToRead)
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset)
      content = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }

    const parsed = parseProcessLogTail(content, {
      bytesTruncated: offset > 0,
      limit: MAX_TAIL_LINES,
    })
    const warnings = [
      ...(offset > 0 ? ['日志文件较大，页面只读取最后 512 KiB。'] : []),
      ...(parsed.lineLimitTruncated ? [`页面只显示最后 ${MAX_TAIL_LINES} 行。`] : []),
    ]
    return processLogSnapshotSchema.parse({
      schemaVersion: 2,
      generatedAt: now.toISOString(),
      selectedSource,
      sources,
      entries: parsed.entries,
      bytesTruncated: offset > 0,
      lineLimitTruncated: parsed.lineLimitTruncated,
      warnings,
    })
  } catch {
    return processLogSnapshotSchema.parse({
      schemaVersion: 2,
      generatedAt: now.toISOString(),
      selectedSource,
      sources,
      entries: [],
      bytesTruncated: false,
      lineLimitTruncated: false,
      warnings: [`${selected.label} 日志读取失败。`],
    })
  }
}
