/**
 * Sample matrix — API.md Wave 4 Stage 1, item 4:
 * "baseline = defaults + sentinel '⟦fdn:prop:<name>⟧' for every string prop;
 *  then one-at-a-time variation of every enum value and both booleans; plus
 *  the pairwise probe set for enum×boolean pairs ... include them as samples
 *  with varied: '<a>+<b>' and both props in props."
 *
 * CONTRACT NOTE on the pairwise `varied` format: API.md gives an explicit,
 * unambiguous format string — "<a>+<b>" (plus-joined, source declaration
 * order: enum prop first, then boolean prop). This module implements that
 * literally. Cross-checking mid-build against the concurrently-built Stage 2
 * (packages/importer/src/types.ts) found it currently assumes a DIFFERENT,
 * self-invented convention (comma-joined, alphabetically sorted prop names),
 * apparently reasoning that the fixed `RenderSample.varied?: string` type
 * "cannot express" two prop names — but API.md already resolves that by
 * fiat with the literal "<a>+<b>" string, so there's nothing to invent. This
 * is flagged prominently in the harvestComponent report as an integration
 * finding: Stage 2's probe-detection should be reconciled to the "+" format,
 * not the other way around, since API.md is the fixed contract here.
 */
import type { FdnProp } from 'foundation-engine'
import type { RenderSample } from '../types.js'

export function sentinelFor(propName: string): string {
  return `⟦fdn:prop:${propName}⟧`
}

export interface SampleMatrixInputs {
  propSchema: FdnProp[]
  enumValues: Map<string, string[]>
  render: (props: Record<string, unknown>) => string
}

function defaultValueFor(prop: FdnProp, enumValues: Map<string, string[]>): unknown {
  switch (prop.type) {
    case 'string':
      return sentinelFor(prop.name)
    case 'boolean':
      return prop.default ?? false
    case 'enum': {
      const values = enumValues.get(prop.name) ?? []
      return prop.default ?? values[0]
    }
    default:
      return prop.default
  }
}

export function buildSampleMatrix(inputs: SampleMatrixInputs): RenderSample[] {
  const { propSchema, enumValues, render } = inputs
  const baselineProps: Record<string, unknown> = {}
  for (const prop of propSchema) {
    baselineProps[prop.name] = defaultValueFor(prop, enumValues)
  }

  const samples: RenderSample[] = [{ props: baselineProps, html: render(baselineProps) }]

  const enumProps = propSchema.filter((p) => p.type === 'enum')
  const boolProps = propSchema.filter((p) => p.type === 'boolean')

  for (const prop of enumProps) {
    for (const value of enumValues.get(prop.name) ?? []) {
      const props = { ...baselineProps, [prop.name]: value }
      samples.push({ varied: prop.name, props, html: render(props) })
    }
  }

  for (const prop of boolProps) {
    for (const value of [true, false]) {
      const props = { ...baselineProps, [prop.name]: value }
      samples.push({ varied: prop.name, props, html: render(props) })
    }
  }

  // Pairwise probe set (enum × boolean), for Stage 2's composed-variant /
  // interaction check. See module doc: "<a>+<b>", enum prop first.
  for (const enumProp of enumProps) {
    for (const boolProp of boolProps) {
      for (const enumValue of enumValues.get(enumProp.name) ?? []) {
        for (const boolValue of [true, false]) {
          const props = { ...baselineProps, [enumProp.name]: enumValue, [boolProp.name]: boolValue }
          samples.push({ varied: `${enumProp.name}+${boolProp.name}`, props, html: render(props) })
        }
      }
    }
  }

  return samples
}
