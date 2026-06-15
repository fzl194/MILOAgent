import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'

import { zodToJsonSchema } from './schema'

describe('zodToJsonSchema', () => {
  it('emits an object schema with typed properties', () => {
    const out = zodToJsonSchema(z.object({ path: z.string() }))
    expect(out.type).toBe('object')
    expect((out.properties as Record<string, unknown>).path).toMatchObject({ type: 'string' })
  })

  it('lists only required (non-optional) fields', () => {
    const out = zodToJsonSchema(z.object({ path: z.string(), opt: z.string().optional() }))
    expect(out.required).toEqual(['path'])
  })

  it('carries .describe() into the property description', () => {
    const out = zodToJsonSchema(z.object({ path: z.string().describe('A file path') }))
    expect((out.properties as Record<string, { description?: string }>).path.description).toBe(
      'A file path'
    )
  })

  it('caches by schema identity — same reference returns the same object', () => {
    const schema = z.object({ path: z.string() })
    expect(zodToJsonSchema(schema)).toBe(zodToJsonSchema(schema))
  })
})
