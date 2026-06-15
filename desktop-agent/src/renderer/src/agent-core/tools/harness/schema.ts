// Zod → JSON Schema conversion. Replicates Claude Code's
// src/utils/zodToJsonSchema.ts: the native `toJSONSchema` from zod/v4 is the
// single source for both runtime validation (safeParse) and the wire schema we
// hand to OpenAI-compatible backends (GLM/DeepSeek function calling).
//
// Tool schemas are stable object literals built once at module load, so caching
// by ZodTypeAny identity avoids re-serializing the same schema on every turn.

import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

export type JsonSchema7 = Record<string, unknown>

const cache = new WeakMap<ZodTypeAny, JsonSchema7>()

/** Convert a Zod v4 schema to a JSON Schema object. Cached by schema identity. */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7 {
  const hit = cache.get(schema)
  if (hit) return hit
  const out = toJSONSchema(schema) as JsonSchema7
  cache.set(schema, out)
  return out
}
