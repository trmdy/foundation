/**
 * Composition fixture — a string prop (title, sentinel-tested), a boolean
 * prop (elevated, changes which Tailwind class is present), and `children`
 * typed as ReactNode — deliberately NOT auto-classifiable (string | boolean
 * | string-literal-union only, per API.md item 2), so harvesting this
 * fixture REQUIRES a `props` override for `children`. Per API.md's fixture
 * note: "children as a slot-ish prop — for v1 render children as a fixed
 * sentinel string" — the caller passes `{ name: 'children', type: 'string' }`
 * as an override, which reuses the same sentinel mechanism as any other
 * string prop (see harness/samples.ts's sentinelFor).
 */
import type { ReactNode } from 'react'

export interface CardProps {
  title: string
  elevated?: boolean
  children: ReactNode
}

export function Card({ title, elevated = false, children }: CardProps) {
  return (
    <div className={`rounded-lg border border-gray-200 p-4 hover:shadow-md ${elevated ? 'shadow-lg' : 'shadow-sm'}`}>
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      <div className="mt-2 text-gray-600">{children}</div>
    </div>
  )
}
