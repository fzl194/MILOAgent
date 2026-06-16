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
  const raw = toJSONSchema(schema) as JsonSchema7
  // Strip the Draft 2020-12 document marker (`$schema`) and the strict
  // `additionalProperties:false` zod/v4 emits by default. Some OpenAI-compatible
  // backends (GLM/DeepSeek function calling) reject requests carrying extra
  // schema fields, and the legacy hand-written tool definitions never set them —
  // this restores wire-schema parity. Recursive so NESTED object params (any
  // depth) are also cleaned — a tool with `{ git_diff: { repo, files[] } }`
  // would otherwise leak `additionalProperties:false` on the inner object and
  // be rejected by GLM/DeepSeek.
  const out = stripSchemaExtras(raw) as JsonSchema7
  cache.set(schema, out)
  return out
}

/** Recursively delete `$schema` and `additionalProperties` from a JSON-Schema
 *  node and all its `properties` children. Arrays are mapped element-wise. */
function stripSchemaExtras(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(stripSchemaExtras)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === '$schema' || k === 'additionalProperties') continue
    out[k] = stripSchemaExtras(v)
  }
  return out
}
