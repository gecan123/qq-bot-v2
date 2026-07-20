import { createServerFn } from '@tanstack/react-start'
import { loadLifeSnapshot } from './life.server.js'
export const getLifeSnapshot = createServerFn({ method: 'GET' }).handler(() => loadLifeSnapshot())
