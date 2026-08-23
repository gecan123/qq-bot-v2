export type EnvSource = Record<string, string | undefined>

export function requireEnv(env: EnvSource, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return defaultValue
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return defaultValue
}

export function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue
  return Math.floor(parsed)
}

export function parseStrictPositiveInteger(name: string, value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} "${value}" (must be positive safe integer)`)
  }
  return parsed
}

export function parseStrictNonNegativeInteger(name: string, value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') return defaultValue
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name} "${value}" (must be a non-negative safe integer)`)
  }
  return parsed
}

export function parsePositiveSafeInteger(name: string, value: string): number {
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} "${value}" (must be positive safe integer)`)
  }
  return parsed
}

export function parseEnumValue<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return defaultValue
  if ((allowed as readonly string[]).includes(normalized)) return normalized as T
  throw new Error(`Invalid ${name} "${value}" (expected ${allowed.join(' or ')})`)
}

export function parseOptionalEnumValue<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if ((allowed as readonly string[]).includes(normalized)) return normalized as T
  throw new Error(`Invalid ${name} "${value}" (expected ${allowed.join(' or ')})`)
}
