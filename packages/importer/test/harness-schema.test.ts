import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectComponent, extractPropSchema } from '../src/harness/schema.js'
import { HarnessError } from '../src/errors.js'

const fixturesDir = path.resolve(import.meta.dirname, '../fixtures')
function readFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), 'utf8')
}

describe('detectComponent', () => {
  it('detects a named export function with a destructured, typed param', () => {
    const source = readFixture('button.tsx')
    const detected = detectComponent(source, 'button')
    expect(detected.exportedName).toBe('Button')
    expect(detected.isDefaultExport).toBe(false)
    expect(detected.displayName).toBe('Button')
    expect(detected.propsTypeName).toBe('ButtonProps')
    expect(detected.paramDestructureBody).toContain('variant')
  })

  it('applies a name override', () => {
    const source = readFixture('button.tsx')
    const detected = detectComponent(source, 'button', 'MyButton')
    expect(detected.displayName).toBe('MyButton')
  })

  it('detects "export default function Name(...)"', () => {
    const source = `
      export interface WidgetProps {
        label: string
      }
      export default function Widget({ label }: WidgetProps) {
        return null
      }
    `
    const detected = detectComponent(source, 'widget')
    expect(detected.exportedName).toBe('Widget')
    expect(detected.isDefaultExport).toBe(true)
    expect(detected.propsTypeName).toBe('WidgetProps')
  })

  it('detects "export const Name = (...) =>"', () => {
    const source = `
      export interface ThingProps {
        active: boolean
      }
      export const Thing = ({ active }: ThingProps) => {
        return null
      }
    `
    const detected = detectComponent(source, 'thing')
    expect(detected.exportedName).toBe('Thing')
    expect(detected.isDefaultExport).toBe(false)
    expect(detected.propsTypeName).toBe('ThingProps')
  })

  it('throws a legible schema-unresolvable error when no supported export shape is found', () => {
    const source = `const x = 1`
    expect(() => detectComponent(source, 'nothing')).toThrow(HarnessError)
    try {
      detectComponent(source, 'nothing')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError)
      expect((err as HarnessError).code).toBe('schema-unresolvable')
    }
  })
})

describe('extractPropSchema', () => {
  it('extracts cva-derived enums, an explicit boolean, and an explicit string from button.tsx', () => {
    const source = readFixture('button.tsx')
    const detected = detectComponent(source, 'button')
    const { propSchema, enumValues } = extractPropSchema(source, detected)

    const byName = Object.fromEntries(propSchema.map((p) => [p.name, p]))
    expect(byName.variant).toMatchObject({ type: 'enum', default: 'default' })
    expect(byName.size).toMatchObject({ type: 'enum', default: 'default' })
    expect(byName.disabled).toMatchObject({ type: 'boolean', default: false })
    expect(byName.children).toMatchObject({ type: 'string' })

    expect(enumValues.get('variant')).toEqual(['default', 'destructive', 'outline'])
    expect(enumValues.get('size')).toEqual(['default', 'sm', 'lg'])

    // Stage 1 enhancement (API.md Wave 4 item 4): the enum FdnProp itself is
    // now self-describing — `values` mirrors what enumValues carries, so a
    // consumer reading propSchema alone (without the separate enumValues
    // map) still knows the domain.
    expect(byName.variant?.values).toEqual(['default', 'destructive', 'outline'])
    expect(byName.size?.values).toEqual(['default', 'sm', 'lg'])
    expect(byName.disabled?.values).toBeUndefined()
    expect(byName.children?.values).toBeUndefined()
  })

  it('extracts a single-group cva enum from badge.tsx (no booleans)', () => {
    const source = readFixture('badge.tsx')
    const detected = detectComponent(source, 'badge')
    const { propSchema, enumValues } = extractPropSchema(source, detected)
    const byName = Object.fromEntries(propSchema.map((p) => [p.name, p]))
    expect(byName.variant).toMatchObject({ type: 'enum', default: 'default' })
    expect(propSchema.some((p) => p.type === 'boolean')).toBe(false)
    expect(enumValues.get('variant')).toEqual(['default', 'success', 'warning'])
    expect(byName.variant?.values).toEqual(['default', 'success', 'warning'])
  })

  it('extracts a required string + boolean from card.tsx, and errors on the ReactNode children field', () => {
    const source = readFixture('card.tsx')
    const detected = detectComponent(source, 'card')
    expect(() => extractPropSchema(source, detected)).toThrow(HarnessError)
    try {
      extractPropSchema(source, detected)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessError)
      expect((err as HarnessError).code).toBe('schema-unresolvable')
      expect((err as Error).message).toContain('children')
    }
  })

  it('accepts an override for the unclassifiable card.tsx children field, and overrides always win', () => {
    const source = readFixture('card.tsx')
    const detected = detectComponent(source, 'card')
    const { propSchema } = extractPropSchema(source, detected, [
      { name: 'children', type: 'string', required: true },
      { name: 'title', type: 'string', default: 'Overridden' },
    ])
    const byName = Object.fromEntries(propSchema.map((p) => [p.name, p]))
    expect(byName.children).toEqual({ name: 'children', type: 'string', required: true })
    expect(byName.title).toEqual({ name: 'title', type: 'string', default: 'Overridden' })
    expect(byName.elevated).toMatchObject({ type: 'boolean', default: false })
  })

  it('extracts a single optional string prop from icon.tsx', () => {
    const source = readFixture('icon.tsx')
    const detected = detectComponent(source, 'icon')
    const { propSchema } = extractPropSchema(source, detected)
    expect(propSchema).toEqual([{ name: 'label', type: 'string', required: false }])
  })

  it('populates values for a plain string-literal-union enum (not cva-derived)', () => {
    // Stage 1 enhancement (API.md Wave 4 item 4), the OTHER enum-producing
    // path besides cva groups: `classifyFieldType` already detected a
    // string-literal union as `type: 'enum'` and recorded it into the
    // enumValues map (for the sample matrix); this asserts the returned
    // FdnProp carries the same domain on its own `values` field too.
    const source = `
      export interface ToastProps {
        tone: 'info' | 'success' | 'danger'
        message: string
      }
      export function Toast({ tone, message }: ToastProps) {
        return <div>{message}</div>
      }
    `
    const detected = detectComponent(source, 'toast')
    const { propSchema, enumValues } = extractPropSchema(source, detected)
    const byName = Object.fromEntries(propSchema.map((p) => [p.name, p]))
    expect(byName.tone).toMatchObject({ type: 'enum', required: true })
    expect(byName.tone?.values).toEqual(['info', 'success', 'danger'])
    expect(enumValues.get('tone')).toEqual(['info', 'success', 'danger'])
    expect(byName.message?.values).toBeUndefined()
  })
})
