export interface ToolResultProgressTracker {
  observe(key: string, content: string): boolean
}

export function createToolResultProgressTracker(maxEntries = 100): ToolResultProgressTracker {
  const previous = new Map<string, string>()
  const limit = Math.max(1, maxEntries)

  return {
    observe(key, content) {
      const changed = previous.get(key) !== content
      previous.delete(key)
      previous.set(key, content)
      while (previous.size > limit) {
        const oldest = previous.keys().next().value as string | undefined
        if (oldest == null) break
        previous.delete(oldest)
      }
      return changed
    },
  }
}
