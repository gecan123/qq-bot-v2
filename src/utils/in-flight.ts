export function withInFlight<K>(
  cache: Map<K, Promise<void>>,
  key: K,
  fn: () => Promise<void>,
): Promise<void> {
  if (cache.has(key)) return cache.get(key)!
  const p = fn().finally(() => cache.delete(key))
  cache.set(key, p)
  return p
}
