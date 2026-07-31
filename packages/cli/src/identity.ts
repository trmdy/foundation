/**
 * foundation-cli — CLI author identity default (SPEC 13a-ii, resolved
 * 2026-07-31): "CLI defaults to `user:<os-username>@<hostname>`, never a
 * shared literal (peer ids derive from author strings; shared defaults
 * collide — proven). Hive identity overrides when present."
 *
 * Every CLI command that previously hardcoded `'user:local'` as its
 * `--author` default now calls `defaultAuthor()` instead. `crypto.randomUUID`
 * and `os.userInfo/os.hostname` are the CLI's own randomness/environment
 * boundary — the engine (packages/engine) stays free of both.
 */
import { hostname, userInfo } from 'node:os'

export function defaultAuthor(): string {
  const bee = process.env.HIVE_BEE
  if (bee) return `agent:${bee}`
  return `user:${userInfo().username}@${hostname()}`
}
