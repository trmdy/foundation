/**
 * Simpler cva fixture — a single enum variant group, no booleans. Acceptance
 * fixture per API.md Wave 4 ("vendored fixtures — ... badge ...").
 */
import { cva, type VariantProps } from './lib/cva.js'

const badgeVariants = cva('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', {
  variants: {
    variant: {
      default: 'bg-blue-100 text-blue-800',
      success: 'bg-green-100 text-green-800',
      warning: 'bg-amber-100 text-amber-800',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
})

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children?: string
}

export function Badge({ variant, children }: BadgeProps) {
  return <span className={badgeVariants({ variant })}>{children}</span>
}
