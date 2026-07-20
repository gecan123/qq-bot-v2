import { createServerFn } from '@tanstack/react-start'
import { memoryFileInputSchema } from './memory.schema.js'
import { loadMemoryFile, loadMemorySnapshot } from './memory.server.js'
export const getMemorySnapshot = createServerFn({ method: 'GET' }).handler(() => loadMemorySnapshot())
export const getMemoryFile = createServerFn({ method: 'GET' }).validator(memoryFileInputSchema).handler(({ data }) => loadMemoryFile(data.fileId))
