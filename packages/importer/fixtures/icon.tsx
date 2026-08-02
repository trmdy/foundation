/**
 * lucide-style pure-svg icon fixture, hand-written (no lucide-react
 * dependency, per API.md). Icons are "the degenerate case of the import
 * contract" (SPEC D3): no Tailwind classes at all, so classIndex for this
 * fixture is trivially empty — the only variation is the `label` string
 * prop, sentinel-substituted into an attribute (aria-label) rather than
 * text content, exercising that path too.
 */
export interface IconProps {
  label?: string
}

export function Icon({ label }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 5" />
      <path d="M12 17h.01" />
    </svg>
  )
}
