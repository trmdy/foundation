/**
 * render/browser.ts — pinned-Chromium lifecycle.
 *
 * Lazy singleton: importing this module (or src/render/index.ts, which wires
 * through it) never starts a browser process. A browser is launched only on
 * the first call to getBrowser(), and reused for every subsequent render
 * until closeBrowser() is called — this module never closes itself; tests
 * and the CLI own that lifecycle explicitly (call closeBrowser() in
 * afterAll/on exit so the process doesn't hang on an open browser).
 *
 * Flag set ported verbatim from spikes/render/run.ts's DETERMINISM_FLAGS
 * (docs/SPEC.md §5, spikes/render/RESULTS.md) — see that file for the
 * rationale behind each flag (GPU/rasterization, color/text rendering,
 * compositor/frame timing, motion, timers, network, V8 PRNG). Do not
 * add/remove flags here without re-running the spike's determinism check.
 */

import { chromium, type Browser } from 'playwright'

export const DETERMINISM_FLAGS: readonly string[] = [
  // --- GPU / rasterization: force the software (SwiftShader) path so pixel
  // output does not depend on the local GPU, driver, or ANGLE backend. This
  // is the flag set most likely to matter *cross-machine*, not run-to-run.
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--use-gl=angle',
  '--use-angle=swiftshader',

  // --- Color and text rendering.
  '--force-color-profile=srgb', // ignore the monitor/OS ICC profile
  '--disable-lcd-text', // force grayscale AA instead of subpixel AA
  '--font-render-hinting=none', // FreeType/Linux-only; documented no-op on macOS

  // --- Compositor / frame timing: ensure the screenshot is of a fully
  // composited frame, and raster/image-decode timing can't race the capture.
  '--run-all-compositor-stages-before-draw',
  '--disable-partial-raster',
  '--disable-checker-imaging',
  '--disable-image-animation-resync',
  '--disable-skia-runtime-opts', // stop Skia from selecting a CPU-specific SIMD path

  // --- Motion / UI chrome.
  '--force-prefers-reduced-motion',
  '--hide-scrollbars',

  // --- Timers/throttling: keep background-tab timer throttling from
  // perturbing anything driven by timers.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',

  // --- Network/updates: belt-and-braces for D1's "no network".
  '--disable-domain-reliability',
  '--disable-component-update',

  // --- V8: pin the PRNG in case a fixture touches Math.random().
  '--js-flags=--random-seed=1',
]

let browserPromise: Promise<Browser> | null = null

/** Lazily launches the pinned Chromium once and reuses it for every caller. */
export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, args: [...DETERMINISM_FLAGS] })
  }
  return browserPromise
}

/** Closes the shared browser, if one was launched. Safe to call repeatedly
 *  or when no browser was ever started. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return
  const pending = browserPromise
  browserPromise = null
  const browser = await pending
  await browser.close()
}
