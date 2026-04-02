import { createMemoryQueue } from './memory-queue.js'
import { config } from '../config/index.js'

export const jobQueue = createMemoryQueue(config.jobInterDelayMs)
