/**
 * SSR sandbox — API.md Wave 4 Stage 1, item 3 + SPEC D3 / resolved Q3:
 * "determinism is enforced at compile, not requested": frozen Date, seeded
 * Math.random, banned globals (fetch/XHR/WebSocket/localStorage/
 * sessionStorage/setTimeout(delay>0)/setInterval) throw legible errors
 * naming the API, and a throwing component becomes a structured error, not
 * a crash.
 *
 * Approach chosen (documented): node:vm, one fresh `vm.Context` per
 * harvested component. The bundle (component + react + react-dom/server.node,
 * see compile.ts) is fully self-contained, so the sandbox's `require` only
 * needs to satisfy the small, fixed set of Node builtins react-dom's server
 * renderer itself pulls in (util/crypto/async_hooks/stream/buffer/events/
 * string_decoder) — anything else throws as a banned import, closing the
 * obvious "component does `require('fs')`/`require('child_process')`"
 * escape hatch that the literal browser-global banlist doesn't cover on
 * its own (in the spirit of D3's "no network ever" / "IO" ban).
 *
 * node:vm's `createContext` does NOT reflect intrinsics like Math/Date onto
 * the sandbox object until a script inside that realm explicitly assigns
 * them to `globalThis` — verified empirically. So Date/Math are captured
 * via a one-line bootstrap script run immediately after context creation,
 * then Date is *replaced* (a frozen subclass) and Math.random is mutated
 * in place (same object identity, so later global `Math.random()` lookups
 * see the patched function without needing to rebind the `Math` binding
 * itself).
 *
 * Math.random is reseeded to the same fixed seed at the START of every
 * `render()` call (not left as one continuing stream across samples), so
 * a sample's HTML is a pure function of its own props regardless of
 * sample order — a stronger determinism property than the contract
 * strictly requires, but it's what makes "two harvests byte-identical"
 * trivially true rather than order-dependent.
 */
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { HarnessError } from '../errors.js'

const FROZEN_TIMESTAMP = 1735689600000 // 2025-01-01T00:00:00.000Z — arbitrary, fixed
const RNG_SEED = 0x9e3779b9

const ALLOWED_BUILTINS = new Set(['util', 'crypto', 'async_hooks', 'stream', 'buffer', 'events', 'string_decoder'])

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function random() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function bannedApi(name: string): unknown {
  const trigger = (): never => {
    throw new HarnessError('banned-api', `banned API used in render sandbox: ${name}`)
  }
  return new Proxy(function bannedTarget() {}, {
    apply: trigger,
    construct: trigger,
    get(target, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === Symbol.toStringTag) {
        return (target as unknown as Record<PropertyKey, unknown>)[prop as string]
      }
      return trigger()
    },
  })
}

const hostRequire = createRequire(import.meta.url)

function sandboxRequire(id: string): unknown {
  const bare = id.replace(/^node:/, '')
  if (!ALLOWED_BUILTINS.has(bare)) {
    throw new HarnessError('banned-api', `import of "${id}" is not permitted in the render sandbox`)
  }
  return hostRequire(bare)
}

export interface Sandbox {
  render(props: Record<string, unknown>): string
}

/** Build one sandboxed realm for a compiled bundle and return a `render`
 *  function that always produces the same html for the same props. */
export function createSandbox(bundleCode: string): Sandbox {
  const sandboxModule = { exports: {} as { __render?: (props: unknown) => string } }

  const sandbox: Record<string, unknown> = {
    require: sandboxRequire,
    console,
    module: sandboxModule,
    exports: sandboxModule.exports,
    process: {
      env: { NODE_ENV: 'production' },
      emit: () => false,
      version: process.version,
      platform: process.platform,
    },
    TextEncoder,
    TextDecoder,
    MessageChannel,
    queueMicrotask,
    setTimeout: (fn: (...a: unknown[]) => void, delay?: number) => {
      if (typeof delay === 'number' && delay > 0) {
        throw new HarnessError('banned-api', 'banned API used in render sandbox: setTimeout(delay>0)')
      }
      return 0
    },
    clearTimeout: () => {},
    setInterval: bannedApi('setInterval'),
    clearInterval: () => {},
    fetch: bannedApi('fetch'),
    XMLHttpRequest: bannedApi('XMLHttpRequest'),
    WebSocket: bannedApi('WebSocket'),
    localStorage: bannedApi('localStorage'),
    sessionStorage: bannedApi('sessionStorage'),
  }

  vm.createContext(sandbox)
  new vm.Script('globalThis.__fdnRealDate = Date; globalThis.__fdnRealMath = Math;').runInContext(sandbox)
  const realDate = sandbox.__fdnRealDate as DateConstructor
  const realMath = sandbox.__fdnRealMath as typeof Math
  delete sandbox.__fdnRealDate
  delete sandbox.__fdnRealMath

  class FrozenDate extends realDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(FROZEN_TIMESTAMP)
        return
      }
      super(...(args as ConstructorParameters<typeof Date>))
    }
    static now(): number {
      return FROZEN_TIMESTAMP
    }
  }
  sandbox.Date = FrozenDate

  let renderFn: (props: unknown) => string
  try {
    const script = new vm.Script(bundleCode, { filename: 'fdn-component-bundle.cjs' })
    script.runInContext(sandbox)
  } catch (err) {
    if (err instanceof HarnessError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new HarnessError('compile-error', `bundle failed to evaluate in the render sandbox: ${message}`, {
      cause: err,
    })
  }
  if (typeof sandboxModule.exports.__render !== 'function') {
    throw new HarnessError('compile-error', 'bundled component did not export a render entry point')
  }
  renderFn = sandboxModule.exports.__render

  return {
    render(props: Record<string, unknown>): string {
      realMath.random = mulberry32(RNG_SEED)
      try {
        return renderFn(props)
      } catch (err) {
        if (err instanceof HarnessError) throw err
        const message = err instanceof Error ? err.message : String(err)
        throw new HarnessError('render-error', `component threw during render: ${message}`, { cause: err })
      }
    },
  }
}
