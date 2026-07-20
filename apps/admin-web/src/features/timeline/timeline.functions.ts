import { createServerFn } from '@tanstack/react-start'
import { loadTimelineSnapshot } from './timeline.server.js'
export const getTimelineSnapshot = createServerFn({ method: 'GET' }).handler(() => loadTimelineSnapshot())
