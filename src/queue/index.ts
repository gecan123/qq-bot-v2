import { handleGenerateDescription } from '../jobs/generate-description.js'
import type { GenerateDescriptionData } from '../jobs/generate-description.js'
import { handleRefreshMessageResolution } from '../jobs/refresh-message-resolution.js'
import type { RefreshMessageResolutionData } from '../jobs/refresh-message-resolution.js'
import { jobQueue } from './runtime.js'

export { jobQueue }

jobQueue.register<'generate-description', GenerateDescriptionData>(
  'generate-description',
  handleGenerateDescription,
)

jobQueue.register<'refresh-message-resolution', RefreshMessageResolutionData>(
  'refresh-message-resolution',
  handleRefreshMessageResolution,
)
