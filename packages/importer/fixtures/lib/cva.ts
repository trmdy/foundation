/**
 * Minimal local stand-in for `class-variance-authority`'s `cva()` — NOT a
 * new dependency (class-variance-authority isn't in API.md's installed-deps
 * list, so it isn't installed here). This mirrors just enough of cva's
 * runtime contract (variants config, defaultVariants) and its `VariantProps<>`
 * type helper for the fixtures to be genuinely "ShadCN-style with cva", and
 * for harness/schema.ts's `VariantProps<typeof X>` + `cva(...)` text-pattern
 * extraction to have real, representative source to parse.
 */
export type VariantGroup = Record<string, string>
export type VariantSchema = Record<string, VariantGroup>

export interface CvaConfig<T extends VariantSchema> {
  variants: T
  defaultVariants?: { [K in keyof T]?: keyof T[K] }
}

export type VariantProps<T extends (...args: never[]) => unknown> = NonNullable<Parameters<T>[0]>

export function cva<T extends VariantSchema>(base: string, config: CvaConfig<T>) {
  return (props?: { [K in keyof T]?: keyof T[K] } & { className?: string }): string => {
    const classes = [base]
    for (const group of Object.keys(config.variants)) {
      const chosen = (props?.[group as keyof T] ?? config.defaultVariants?.[group as keyof T]) as
        | string
        | undefined
      const groupValues = config.variants[group] as VariantGroup
      if (chosen && groupValues[chosen]) classes.push(groupValues[chosen] as string)
    }
    if (props?.className) classes.push(props.className)
    return classes.join(' ')
  }
}
