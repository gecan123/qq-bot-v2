import type { z } from 'zod'
import { z as zod } from 'zod'

export function zodToToolJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zod.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema

  // Anthropic 不允许顶层 oneOf/anyOf/allOf。OpenAI function tools 也更稳地吃普通
  // object schema；discriminatedUnion 在这里展平成合并 object。
  const variants = getFlattenableObjectVariants(json)
  if (variants) {
    const mergedProps: Record<string, Record<string, unknown>[]> = {}
    const requiredSets: Set<string>[] = []
    for (const variant of variants) {
      const props = (variant.properties ?? {}) as Record<string, Record<string, unknown>>
      for (const [key, val] of Object.entries(props)) {
        ;(mergedProps[key] ??= []).push(val)
      }
      requiredSets.push(new Set((variant.required as string[]) ?? []))
    }
    const finalProps: Record<string, unknown> = {}
    for (const [key, schemas] of Object.entries(mergedProps)) {
      if (schemas.length === 1) {
        finalProps[key] = schemas[0]
        continue
      }
      const consts = schemas.map((s) => s.const).filter((c) => c !== undefined)
      if (consts.length === schemas.length) {
        const descriptions = schemas.map((s) => s.description).filter(Boolean)
        finalProps[key] = {
          type: schemas[0].type ?? 'string',
          enum: consts,
          ...(descriptions.length > 0 ? { description: descriptions.join(' | ') } : {}),
        }
      } else {
        finalProps[key] = schemas[0]
      }
    }
    const requiredIntersection = requiredSets.reduce((acc, s) => {
      const result = new Set<string>()
      for (const k of acc) if (s.has(k)) result.add(k)
      return result
    })
    delete json.oneOf
    delete json.anyOf
    json.type = 'object'
    json.properties = finalProps
    if (requiredIntersection.size > 0) {
      json.required = [...requiredIntersection]
    } else {
      delete json.required
    }
    return json
  }

  if (json.type === 'object' && !('properties' in json)) {
    json.properties = {}
  }
  return json
}

function getFlattenableObjectVariants(json: Record<string, unknown>): Record<string, unknown>[] | null {
  const rawVariants = getVariantArray(json)
  if (!rawVariants) return null
  return collectObjectVariants(rawVariants)
}

function collectObjectVariants(variants: unknown[]): Record<string, unknown>[] | null {
  const output: Record<string, unknown>[] = []
  for (const variant of variants) {
    const expanded = expandObjectVariant(variant)
    if (!expanded) return null
    output.push(...expanded)
  }
  return output.length > 0 ? output : null
}

function expandObjectVariant(variant: unknown): Record<string, unknown>[] | null {
  if (!isRecord(variant)) return null
  if (variant.type === 'object') return [variant]

  const nestedVariants = getVariantArray(variant)
  if (!nestedVariants) return null
  return collectObjectVariants(nestedVariants)
}

export function zodToOpenAIStrictToolJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToToolJsonSchema(schema)
  return makeOpenAIStrictSchema(json) as Record<string, unknown>
}

export function stripNullsFromOptionalFields(schema: z.ZodTypeAny, value: unknown): unknown {
  const json = zod.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return stripNullOptionals(json, value)
}

function makeOpenAIStrictSchema(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(makeOpenAIStrictSchema)
  if (!isRecord(input)) return input

  const next: Record<string, unknown> = { ...input }
  delete next.format
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(next[key])) {
      next[key] = (next[key] as unknown[]).map(makeOpenAIStrictSchema)
    }
  }

  const properties = isRecord(next.properties)
    ? next.properties as Record<string, unknown>
    : null
  if (!properties) return next

  const originalRequired = new Set(Array.isArray(next.required) ? next.required as string[] : [])
  const finalProperties: Record<string, unknown> = {}
  for (const [key, prop] of Object.entries(properties)) {
    const strictProp = makeOpenAIStrictSchema(prop)
    finalProperties[key] = originalRequired.has(key) ? strictProp : makeNullableSchema(strictProp)
  }

  next.type = 'object'
  next.properties = finalProperties
  next.required = Object.keys(finalProperties)
  next.additionalProperties = false
  return next
}

function makeNullableSchema(input: unknown): unknown {
  if (isNullableSchema(input)) return input
  return { anyOf: [input, { type: 'null' }] }
}

function isNullableSchema(input: unknown): boolean {
  if (!isRecord(input)) return false
  if (input.type === 'null') return true
  if (Array.isArray(input.type) && input.type.includes('null')) return true
  const variants = Array.isArray(input.anyOf) ? input.anyOf : Array.isArray(input.oneOf) ? input.oneOf : null
  return variants?.some((variant) => isRecord(variant) && variant.type === 'null') ?? false
}

function stripNullOptionals(schema: unknown, value: unknown): unknown {
  if (value == null) return value
  if (Array.isArray(value)) {
    const itemSchema = isRecord(schema) ? schema.items : undefined
    return value.map((item) => stripNullOptionals(itemSchema, item))
  }
  if (!isRecord(value) || !isRecord(schema)) return value

  const variants = getSchemaVariants(schema)
  if (variants.length > 0) {
    return stripNullOptionals(selectVariant(variants, value), value)
  }

  const properties = isRecord(schema.properties)
    ? schema.properties as Record<string, unknown>
    : null
  if (!properties) return value

  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : [])
  const output: Record<string, unknown> = { ...value }
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in output)) continue
    if (output[key] === null && !required.has(key)) {
      delete output[key]
      continue
    }
    output[key] = stripNullOptionals(propSchema, output[key])
  }
  return output
}

function getSchemaVariants(schema: Record<string, unknown>): Record<string, unknown>[] {
  const variants = getVariantArray(schema)
  return variants?.every(isRecord) ? variants : []
}

function getVariantArray(schema: Record<string, unknown>): unknown[] | null {
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const variants = schema[key]
    if (Array.isArray(variants)) return variants
  }
  return null
}

function selectVariant(variants: Record<string, unknown>[], value: Record<string, unknown>): Record<string, unknown> {
  let best = variants[0] ?? {}
  let bestScore = Number.NEGATIVE_INFINITY
  for (const variant of variants) {
    const score = variantMatchScore(variant, value)
    if (score > bestScore) {
      best = variant
      bestScore = score
    }
  }
  return best
}

function variantMatchScore(schema: Record<string, unknown>, value: Record<string, unknown>): number {
  const properties = isRecord(schema.properties)
    ? schema.properties as Record<string, Record<string, unknown>>
    : {}
  let score = 0
  for (const [key, propSchema] of Object.entries(properties)) {
    if (propSchema.const !== undefined) {
      if (value[key] !== propSchema.const) return Number.NEGATIVE_INFINITY
      score += 10
    } else if (key in value) {
      score += 1
    }
  }
  return score
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
