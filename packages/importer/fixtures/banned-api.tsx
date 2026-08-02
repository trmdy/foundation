/**
 * Test-only fixture: calls a banned global (fetch) during render, so
 * harvestComponent must reject with a legible HarnessError('banned-api',...)
 * rather than crash or hang. See API.md item 3 / SPEC D3 resolved Q3.
 */
export interface BannedApiProps {
  label?: string
}

export function BannedApiWidget({ label }: BannedApiProps) {
  fetch('https://example.com')
  return <div>{label}</div>
}
