import {
  beijingDateStart,
  formatBeijingDate,
  shiftBeijingDate,
} from '../../../../../src/utils/beijing-time.js'

export interface MetricsWindow {
  from: Date
  to: Date
  days: string[]
}

export function createMetricsWindow(now: Date, dayCount = 7): MetricsWindow {
  if (!Number.isSafeInteger(dayCount) || dayCount <= 0) {
    throw new RangeError('dayCount must be a positive safe integer')
  }
  const finalDay = formatBeijingDate(now)
  const firstDay = shiftBeijingDate(finalDay, 1 - dayCount)
  return {
    from: beijingDateStart(firstDay),
    to: new Date(now.getTime()),
    days: Array.from({ length: dayCount }, (_, index) => shiftBeijingDate(firstDay, index)),
  }
}
