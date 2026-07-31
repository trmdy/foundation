# Render-determinism spike — RESULTS

Generated: 2026-07-31T10:46:42.759Z
Machine: `Mac.home` (darwin/arm64, 25.5.0, Apple M4 Max)
Chromium: 151.0.7922.34 (`/Users/trmd/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`)
Playwright: 1.62.0
Frozen clock: 2026-07-31T12:00:00.000Z

## Verdict (this machine, run-to-run)

**Bit-identical: YES** — every viewport produced byte-identical PNGs across two fresh-context renders.
**Layout-identical: YES** — every viewport's `getBoundingClientRect()` report was identical (exact float equality) across both runs.

## Per-viewport results

| Viewport | Bit-identical | Exact diff px | pixelmatch diff px | Diff region | Layout identical |
|---|---|---|---|---|---|
| mobile-390x844 (390x1218) | yes | 0 | 0 | n/a | yes |
| tablet-834x1194 (834x1194) | yes | 0 | 0 | n/a | yes |
| desktop-1440x900 (1440x988) | yes | 0 | 0 | n/a | yes |

## Flag set used

```
--disable-gpu
--disable-gpu-compositing
--use-gl=angle
--use-angle=swiftshader
--force-color-profile=srgb
--disable-lcd-text
--font-render-hinting=none
--run-all-compositor-stages-before-draw
--disable-partial-raster
--disable-checker-imaging
--disable-image-animation-resync
--disable-skia-runtime-opts
--force-prefers-reduced-motion
--hide-scrollbars
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
--disable-domain-reliability
--disable-component-update
--js-flags=--random-seed=1
```

Context options (Playwright `newContext`):

```json
{
  "deviceScaleFactor": 1,
  "colorScheme": "light",
  "reducedMotion": "reduce",
  "forcedColors": "none",
  "timezoneId": "UTC",
  "locale": "en-US"
}
```

Notes: `--font-render-hinting=none` is a FreeType/Linux-only switch and is a documented no-op on macOS (this run used CoreText); it is kept in the flag set because the cross-machine leg of this protocol may run on Linux. The GPU/ANGLE flags (`--disable-gpu`, `--use-gl=angle --use-angle=swiftshader`) target *cross-machine* determinism — forcing the same software rasterizer regardless of the local GPU — and are not expected to change anything run-to-run on one machine with one GPU.

## Honest assessment

On this machine, with this flag set, chromium+playwright render the fixture as a pure function of (document, render config): identical input produced byte-identical PNGs and exactly-equal layout reports across two independent browser contexts, at all three viewports. That is the strongest result available from a single-machine run; it does **not** by itself demonstrate cross-machine bit-identity — see the protocol below.

**Prediction for cross-machine (different hardware, possibly different OS):** bit-identical PNGs are unlikely to hold in general, even with an identical pinned Chromium build and this flag set. The remaining sources of divergence that no chromium flag fully removes:

- **Font rasterization backend differs by OS**: macOS uses CoreText, Linux uses FreeType, Windows uses DirectWrite/GDI. `--font-render-hinting` only affects FreeType. Even with the *same* embedded woff2 font (as this fixture does, specifically to remove font-substitution as a variable), the hinting/AA/sub-pixel-positioning pipeline that turns outlines into pixels is platform-native and not fully overridable from Chromium flags.
- **GPU/CPU floating-point and SIMD paths**: `--disable-gpu` + SwiftShader forces a common software rasterizer, and `--disable-skia-runtime-opts` disables Skia's CPU-specific SIMD dispatch, which closes most but not all of this gap — floating-point reassociation differences across CPU architectures (e.g. Apple Silicon vs x86_64) can still produce off-by-one-bit color values in gradients, shadows, and anti-aliased edges.
- **OS color management**: `--force-color-profile=srgb` removes the *display* ICC profile as a variable, but does not guarantee bit-identical color-space math across OS image/graphics stacks.

**Recommended honest contract for docs/SPEC.md §5 / docs/PRD.md success criterion 3**: commit to **layout-identical** (exact `getBoundingClientRect()` equality) as the hard guarantee — that's a DOM/CSS-engine result, not a rasterizer result, and this spike's run-to-run data supports it holding deterministically given a pinned engine and frozen inputs. For pixels, commit to **pixel-identical within a near-zero tolerance** (pixelmatch threshold, reported per-render) rather than byte-identical, and treat any run that exceeds the tolerance as a real regression. Cross-machine byte-identical PNGs should not be a promise in the spec; if the second-machine run below comes back bit-identical anyway, that's a bonus, not something to rely on.

## Cross-machine protocol

This machine's run wrote `spikes/render/out/hashes.json` — one sha256 per PNG and per layout report, plus the chromium version/flags/context options used to produce them. To check a second machine over the tailnet:

1. On machine B, get the same source (same commit/worktree of this spike):
   ```sh
   # from machine A, or via your normal git remote
   rsync -av --exclude node_modules \
     <thisRepoPath>/ <machineB-tailscale-name>:~/foundation-render-check/
   ```
2. On machine B:
   ```sh
   ssh <machineB-tailscale-name>
   cd ~/foundation-render-check
   pnpm install
   pnpm exec playwright install chromium   # same pinned playwright version -> same chromium build
   pnpm spike:render
   ```
   This regenerates `spikes/render/out/hashes.json` and `RESULTS.md` on machine B, using the identical fixture, flag set, and frozen clock (they're checked into the worktree/commit you copied over — nothing is machine-specific in this spike).
3. Pull machine B's hashes back to machine A and diff:
   ```sh
   scp <machineB-tailscale-name>:~/foundation-render-check/spikes/render/out/hashes.json \
     /tmp/hashes-machine-b.json
   diff <(jq -S . spikes/render/out/hashes.json) <(jq -S . /tmp/hashes-machine-b.json)
   ```
   - If `diff` prints nothing beyond the `machine`/`generatedAt` fields (strip those with `jq 'del(.machine, .generatedAt)'` on both sides before diffing for a clean compare): every PNG and layout report hashed identically across machines — the strongest possible result.
   - If PNG hashes differ but layout hashes match: rasterization diverged (font/GPU/color-space — see "Honest assessment" above), layout did not. This is the expected outcome per this spike's prediction, and (per the recommended contract above) should be treated as *acceptable*, not a failure.
   - If layout hashes differ too: something more fundamental disagrees between the two Chromium builds/platforms (a real bug to chase — check `browserVersion` in both `hashes.json` files matches first).
   - For a visual read on any PNG mismatch, pull the actual PNGs (not just hashes) from machine B (`spikes/render/out/<viewport>/run1.png`) and run this harness's pixelmatch step manually, or just eyeball them side by side.
