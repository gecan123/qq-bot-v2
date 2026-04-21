import { handleGenerateDescription } from '../jobs/generate-description.js'
import type { GenerateDescriptionData } from '../jobs/generate-description.js'
import { jobQueue } from './runtime.js'

export { jobQueue }

jobQueue.register<'generate-description', GenerateDescriptionData>(
  'generate-description',
  handleGenerateDescription,
)
