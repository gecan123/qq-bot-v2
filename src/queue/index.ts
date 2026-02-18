import { handleGenerateDescription } from '../jobs/generate-description.js'
import type { GenerateDescriptionData } from '../jobs/generate-description.js'
import { createMemoryQueue } from './memory-queue.js'
import { config } from '../config/index.js'

export const jobQueue = createMemoryQueue(config.jobInterDelayMs)

jobQueue.register<'generate-description', GenerateDescriptionData>(
  'generate-description',
  handleGenerateDescription,
)
