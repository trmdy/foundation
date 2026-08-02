/**
 * ShadCN-style button fixture — cva variant + size enums, a disabled
 * boolean, and Tailwind classes including hover: and focus: variants.
 * Acceptance fixture per API.md Wave 4 ("vendored fixtures — ShadCN-style
 * button (cva variants) ...").
 */
import { cva, type VariantProps } from './lib/cva.js'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus:outline-none focus:ring-2 hover:opacity-90 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-blue-600 text-white hover:bg-blue-700',
        destructive: 'bg-red-600 text-white hover:bg-red-700',
        outline: 'border border-gray-300 bg-white text-gray-900 hover:bg-gray-50',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 px-3',
        lg: 'h-11 px-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps extends VariantProps<typeof buttonVariants> {
  disabled?: boolean
  children?: string
}

export function Button({ variant, size, disabled = false, children }: ButtonProps) {
  return (
    <button className={buttonVariants({ variant, size })} disabled={disabled}>
      {children}
    </button>
  )
}
