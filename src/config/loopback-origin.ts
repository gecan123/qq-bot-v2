const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function parseLoopbackHttpOrigin(
  name: string,
  value: string,
  options: { requirePort?: boolean } = {},
): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(errorMessage(name, options.requirePort === true))
  }
  if (
    url.protocol !== 'http:'
    || !LOOPBACK_HOSTS.has(url.hostname)
    || (options.requirePort === true && !url.port)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error(errorMessage(name, options.requirePort === true))
  }
  return url.origin
}

function errorMessage(name: string, requirePort: boolean): string {
  return `${name} must be an origin-only loopback HTTP URL${requirePort ? ' with an explicit port' : ''}`
}
