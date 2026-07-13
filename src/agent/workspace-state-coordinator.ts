export interface WorkspaceStateCoordinator {
  withWrite<T>(resourceKey: string, task: () => Promise<T>): Promise<T>
}

export function createWorkspaceStateCoordinator(): WorkspaceStateCoordinator {
  const tails = new Map<string, Promise<void>>()

  return {
    async withWrite<T>(resourceKey: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(resourceKey) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => {
        release = resolve
      })
      const tail = previous.then(() => current)
      tails.set(resourceKey, tail)

      await previous
      try {
        return await task()
      } finally {
        release()
        if (tails.get(resourceKey) === tail) tails.delete(resourceKey)
      }
    },
  }
}
