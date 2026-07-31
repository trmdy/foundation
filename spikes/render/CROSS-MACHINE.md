# Cross-machine render results — 2026-07-31

Protocol from RESULTS.md executed between:

| | Machine A | Machine B |
|---|---|---|
| host | Mac.home (Apple M4 Max) | trmd-metal-1 (AMD EPYC 9454P) |
| OS / arch | macOS 25.5.0 / arm64 | Linux 6.8.0 / x86_64 |
| text stack | CoreText | FreeType |
| Chromium | 151.0.7922.34 (playwright pin) | 151.0.7922.34 (playwright pin) |

Both machines were individually **bit-identical run-to-run** on all three viewports.

## Cross-machine comparison

- **PNG hashes: differ** on all viewports (expected — antialiasing/rasterization).
- **Layout hashes: differ** on all viewports — but the divergence decomposes cleanly:
  - **Every element set in the embedded font (Georgia woff2 subset) is float-exact
    across machines** — width and height equal to the last 1/64px, verified per
    element (`heading-display`, `heading-sub`, `heading-tertiary`, card headings).
  - **All divergence traces to system-font text**: the body paragraph
    (`font-family: var(--fdn-font-system)`) measures 604.69px wide on macOS (SF) vs
    533.91px on Linux (DejaVu/Liberation class) — a different typeface, so different
    advance widths, different wrapping, and a one-line-height (~22–24px) vertical
    shift cascading to every subsequent element.

## Conclusion for the SPEC §5 render contract

1. **Bundled fonts are the determinism boundary.** At render time the contract must
   forbid resolving text through OS font stacks: the render config carries a pinned,
   bundled font set, and generic families (`system-ui`, `sans-serif`, `serif`,
   `monospace`) map deterministically onto it. Documents may still author
   `system-ui`; the renderer substitutes, and the substitution is part of the pinned
   config.
2. **With fonts bundled, cross-machine layout identity is empirically exact** — a
   hard guarantee, not a tolerance. (Caveat: one fixture, one machine pair; the
   conformance suite needs adversarial font fixtures — ligatures, fallback glyphs,
   CJK — before 1.0 hardens this into normative text.)
3. **Pixels get a two-tier contract**: byte-identical per (platform, pinned browser);
   across platforms, antialiasing differs. Therefore designate a **reference render
   platform** — linux-x86_64 headless shell, the cheapest to reproduce anywhere (CI,
   metal, any bee) — as the source of canonical pixels for freeze verification and
   QA diffing. Renders elsewhere are previews, compared with pixelmatch tolerance.

Raw evidence: `out/hashes.json` (machine A) vs the fetched machine-B copy; per-element
comparison scripted over `out/desktop-1440x900/layout-run1.json` of both machines.
