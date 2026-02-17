export interface Job<T extends string = string, D = unknown> {
  id: string
  type: T
  data: D
  createdAt: number
  attempts: number
}

export type JobHandler<T extends string, D> = (job: Job<T, D>) => Promise<void>

export interface JobQueue {
  enqueue<T extends string, D>(type: T, data: D): void
  register<T extends string, D>(type: T, handler: JobHandler<T, D>): void
  start(): void
  stop(): void
}
