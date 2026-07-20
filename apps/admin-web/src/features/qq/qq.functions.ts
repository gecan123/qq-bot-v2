import { createServerFn } from '@tanstack/react-start'
import { qqGroupInputSchema } from './qq.schema.js'
import { loadQqGroupSnapshot, loadQqSnapshot } from './qq.server.js'
export const getQqSnapshot = createServerFn({ method: 'GET' }).handler(() => loadQqSnapshot())
export const getQqGroupSnapshot = createServerFn({ method: 'GET' }).validator(qqGroupInputSchema).handler(({ data }) => loadQqGroupSnapshot(data.groupId))
