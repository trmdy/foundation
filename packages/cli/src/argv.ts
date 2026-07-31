/**
 * foundation-cli — zero-dependency argv parsing (API.md: "Zero-dependency
 * argv parsing"). Deliberately tiny: positionals in order, `--flag value` /
 * `--flag=value` / `-f value` / bare `--flag` boolean flags. No subcommand
 * awareness — main.ts strips the command word before calling this.
 */
export interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean>
}

function looksLikeFlag(s: string | undefined): boolean {
  return s !== undefined && s.startsWith('-') && s !== '-'
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      const next = argv[i + 1]
      if (!looksLikeFlag(next) && next !== undefined) {
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const body = arg.slice(1)
      const next = argv[i + 1]
      if (!looksLikeFlag(next) && next !== undefined) {
        flags[body] = next
        i++
      } else {
        flags[body] = true
      }
      continue
    }
    positionals.push(arg)
  }

  return { positionals, flags }
}

export function flagString(flags: Record<string, string | boolean>, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = flags[name]
    if (typeof v === 'string') return v
  }
  return undefined
}
