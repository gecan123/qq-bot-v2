import { handleGenerateDescription } from '../jobs/generate-description.js'
import type { GenerateDescriptionData } from '../jobs/generate-description.js'
import { createMemoryQueue } from './memory-queue.js'

export const jobQueue = createMemoryQueue()

jobQueue.register<'generate-description', GenerateDescriptionData>(
  'generate-description',
  handleGenerateDescription,
)
