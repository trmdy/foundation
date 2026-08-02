/**
 * Test-only fixture: throws a plain Error during render, so harvestComponent
 * must surface it as a structured HarnessError('render-error', ...), not an
 * uncaught crash. See API.md item 3: "Component throwing during render =
 * structured error, not a crash."
 */
export interface RenderThrowProps {
  label?: string
}

export function RenderThrow({ label }: RenderThrowProps): never {
  void label
  throw new Error('boom from inside the component')
}
