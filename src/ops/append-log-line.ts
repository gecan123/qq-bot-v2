import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function appendLogLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, line, 'utf8')
}
