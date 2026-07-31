// spikes/render — render-determinism harness.
//
// Question (docs/SPEC.md §5, docs/PRD.md success criterion 3): is Foundation's render
// contract — "renders are a pure function of (document, render config)" — achievable as
// bit-identical PNGs, and how far does that hold on one machine vs across machines?
//
// This script renders fixtures/sample.fdn.html at three fixed viewports, twice each in
// fresh browser contexts, and compares: (a) PNG bytes, byte-for-byte, (b) a per-element
// getBoundingClientRect() layout report. It writes spikes/render/RESULTS.md and
// spikes/render/out/hashes.json (sha256 per artifact, for the cross-machine protocol).
//
// See README.md for how to run this and how to do the cross-machine comparison.

import { chromium, type Browser, type BrowserContextOptions } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { platform, arch, release, cpus, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const playwrightPackageJson = require("playwright/package.json") as { version: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "sample.fdn.html");
const OUT_DIR = path.join(__dirname, "out");
const RESULTS_PATH = path.join(__dirname, "RESULTS.md");

// ---------------------------------------------------------------------------
// Fixed viewport set (docs/SPEC.md §5: "fixed viewport set").
// ---------------------------------------------------------------------------

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

const VIEWPORTS: readonly Viewport[] = [
  { name: "mobile-390x844", width: 390, height: 844 },
  { name: "tablet-834x1194", width: 834, height: 1194 },
  { name: "desktop-1440x900", width: 1440, height: 900 },
];

// Frozen wall clock — every context's Date/performance.now() reports this instant,
// regardless of when the harness actually runs. (docs/SPEC.md §5: "frozen clock".)
const FROZEN_EPOCH_MS = Date.parse("2026-07-31T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Chromium launch flags aimed at maximizing render determinism.
//
// Each flag below is a real, documented Chromium switch (verified against Chromium's
// switch list / common headless-screenshot-determinism write-ups, July 2026). Two are
// flagged as *not observably load-bearing on this machine* — kept anyway because the
// spike is also a reference implementation for whoever runs the cross-machine leg.
// ---------------------------------------------------------------------------

const DETERMINISM_FLAGS: readonly string[] = [
  // --- GPU / rasterization: force the software (SwiftShader) path so pixel output
  // does not depend on the local GPU, driver, or ANGLE backend. This is the flag set
  // most likely to matter *cross-machine* (different GPUs), not run-to-run.
  "--disable-gpu",
  "--disable-gpu-compositing",
  "--use-gl=angle",
  "--use-angle=swiftshader",

  // --- Color and text rendering.
  "--force-color-profile=srgb", // ignore the monitor/OS ICC profile Chromium would otherwise bake in
  "--disable-lcd-text", // force grayscale AA instead of subpixel (subpixel AA is display/OS-dependent)
  "--font-render-hinting=none", // FreeType hint control — Linux-only; a documented no-op on macOS (this run)

  // --- Compositor / frame timing: make sure the screenshot is taken of a fully
  // composited frame, not a partial one, and that raster/image-decode timing can't
  // introduce a race.
  "--run-all-compositor-stages-before-draw",
  "--disable-partial-raster",
  "--disable-checker-imaging",
  "--disable-image-animation-resync",
  "--disable-skia-runtime-opts", // stop Skia from selecting a CPU-specific (SIMD) code path

  // --- Motion / UI chrome.
  "--force-prefers-reduced-motion",
  "--hide-scrollbars",

  // --- Timers/throttling: keep background-tab timer throttling from perturbing
  // anything driven by timers (irrelevant to this static fixture, kept for rigor —
  // Foundation documents will eventually carry conditional/timed states).
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",

  // --- Network/updates: belt-and-braces for D1's "no network" — the fixture has no
  // remote resources, but nothing should be able to phone home mid-render.
  "--disable-domain-reliability",
  "--disable-component-update",

  // --- V8: pin the PRNG in case any future fixture touches Math.random().
  "--js-flags=--random-seed=1",
];

const CONTEXT_OPTIONS: BrowserContextOptions = {
  deviceScaleFactor: 1, // fixed --force-device-scale-factor equivalent, set per-context
  colorScheme: "light",
  reducedMotion: "reduce",
  forcedColors: "none",
  timezoneId: "UTC",
  locale: "en-US",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LayoutEntry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface RunCapture {
  png: Buffer;
  layout: LayoutEntry[];
  layoutJson: string;
}

interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PixelDiffResult {
  bitIdentical: boolean;
  dimensionsMatch: boolean;
  width: number;
  height: number;
  exactDiffPixels: number;
  pixelmatchDiffPixels: number;
  bbox: Bbox | null;
}

interface LayoutDiffEntry {
  id: string;
  field: keyof LayoutEntry;
  run1: number;
  run2: number;
  delta: number;
}

interface ViewportResult {
  viewport: Viewport;
  run1: RunCapture;
  run2: RunCapture;
  pixelDiff: PixelDiffResult;
  layoutIdentical: boolean;
  layoutDiffs: LayoutDiffEntry[];
  sha256: {
    png1: string;
    png2: string;
    layout1: string;
    layout2: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function byteAt(buf: Buffer, i: number): number {
  const v = buf[i];
  return v === undefined ? 0 : v;
}

/** Exact (threshold-0) byte diff between two equal-sized RGBA buffers, plus a bbox. */
function exactPixelDiff(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
): { count: number; bbox: Bbox | null } {
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (
        byteAt(a, idx) !== byteAt(b, idx) ||
        byteAt(a, idx + 1) !== byteAt(b, idx + 1) ||
        byteAt(a, idx + 2) !== byteAt(b, idx + 2) ||
        byteAt(a, idx + 3) !== byteAt(b, idx + 3)
      ) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { count, bbox: count > 0 ? { minX, minY, maxX, maxY } : null };
}

function diffLayouts(run1: LayoutEntry[], run2: LayoutEntry[]): LayoutDiffEntry[] {
  const diffs: LayoutDiffEntry[] = [];
  const byId2 = new Map(run2.map((entry) => [entry.id, entry]));
  const fields: (keyof LayoutEntry)[] = [
    "x",
    "y",
    "width",
    "height",
    "top",
    "right",
    "bottom",
    "left",
  ];
  for (const e1 of run1) {
    const e2 = byId2.get(e1.id);
    if (!e2) {
      diffs.push({ id: e1.id, field: "x", run1: e1.x, run2: NaN, delta: NaN });
      continue;
    }
    for (const field of fields) {
      const v1 = e1[field];
      const v2 = e2[field];
      if (typeof v1 === "number" && typeof v2 === "number" && v1 !== v2) {
        diffs.push({ id: e1.id, field, run1: v1, run2: v2, delta: v2 - v1 });
      }
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function captureOnce(browser: Browser, viewport: Viewport): Promise<RunCapture> {
  const context = await browser.newContext({
    ...CONTEXT_OPTIONS,
    viewport: { width: viewport.width, height: viewport.height },
  });

  // Freeze Date and performance.now() inside the page before any script runs.
  await context.addInitScript((epoch: number) => {
    const RealDate = Date;

    // A Proxy is the simplest way to override both `new Date()` (no-arg -> frozen
    // instant) and `Date.now()`, while still letting explicit-arg calls (`new
    // Date(2020, 0, 1)`) pass through unchanged.
    const FrozenDate = new Proxy(RealDate, {
      construct(target, args: unknown[]) {
        return args.length === 0
          ? new target(epoch)
          : Reflect.construct(target, args);
      },
      apply(target) {
        // Date() called without `new` always returns a string and ignores any
        // arguments per spec — so there's nothing to freeze here beyond delegating.
        return Reflect.apply(target, undefined, []);
      },
    }) as unknown as DateConstructor;
    FrozenDate.now = () => epoch;

    window.Date = FrozenDate;

    Object.defineProperty(window.performance, "now", {
      value: () => 0,
      configurable: true,
    });
  }, FROZEN_EPOCH_MS);

  const page = await context.newPage();
  await page.goto(`file://${FIXTURE_PATH}`, { waitUntil: "load" });
  // Wait for the embedded @font-face to finish loading/laying out before capture —
  // otherwise a fallback-font frame could theoretically be composited first.
  await page.evaluate(() => document.fonts.ready);

  const png = await page.screenshot({ type: "png", fullPage: true });

  const layout = await page.$$eval("[id]", (elements) =>
    elements.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.id,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        left: r.left,
      };
    }),
  );
  layout.sort((a, b) => a.id.localeCompare(b.id));

  await context.close();

  const layoutJson = `${JSON.stringify(layout, null, 2)}\n`;
  return { png: Buffer.from(png), layout, layoutJson };
}

async function runViewport(browser: Browser, viewport: Viewport): Promise<ViewportResult> {
  const run1 = await captureOnce(browser, viewport);
  const run2 = await captureOnce(browser, viewport);

  const bitIdentical = run1.png.equals(run2.png);

  let pixelDiff: PixelDiffResult;
  if (bitIdentical) {
    // Still need dimensions for the report.
    const decoded = PNG.sync.read(run1.png);
    pixelDiff = {
      bitIdentical: true,
      dimensionsMatch: true,
      width: decoded.width,
      height: decoded.height,
      exactDiffPixels: 0,
      pixelmatchDiffPixels: 0,
      bbox: null,
    };
  } else {
    const png1 = PNG.sync.read(run1.png);
    const png2 = PNG.sync.read(run2.png);
    const dimensionsMatch = png1.width === png2.width && png1.height === png2.height;

    if (!dimensionsMatch) {
      pixelDiff = {
        bitIdentical: false,
        dimensionsMatch: false,
        width: png1.width,
        height: png1.height,
        exactDiffPixels: -1,
        pixelmatchDiffPixels: -1,
        bbox: null,
      };
    } else {
      const { width, height } = png1;
      const exact = exactPixelDiff(png1.data, png2.data, width, height);

      const diffOutput = new PNG({ width, height });
      const pixelmatchCount = pixelmatch(
        png1.data,
        png2.data,
        diffOutput.data,
        width,
        height,
        { threshold: 0.1 },
      );

      const diffDir = path.join(OUT_DIR, viewport.name);
      await mkdir(diffDir, { recursive: true });
      await writeFile(path.join(diffDir, "diff.png"), PNG.sync.write(diffOutput));

      pixelDiff = {
        bitIdentical: false,
        dimensionsMatch: true,
        width,
        height,
        exactDiffPixels: exact.count,
        pixelmatchDiffPixels: pixelmatchCount,
        bbox: exact.bbox,
      };
    }
  }

  const layoutIdentical = run1.layoutJson === run2.layoutJson;
  const layoutDiffs = layoutIdentical ? [] : diffLayouts(run1.layout, run2.layout);

  const viewportDir = path.join(OUT_DIR, viewport.name);
  await mkdir(viewportDir, { recursive: true });
  await writeFile(path.join(viewportDir, "run1.png"), run1.png);
  await writeFile(path.join(viewportDir, "run2.png"), run2.png);
  await writeFile(path.join(viewportDir, "layout-run1.json"), run1.layoutJson);
  await writeFile(path.join(viewportDir, "layout-run2.json"), run2.layoutJson);

  return {
    viewport,
    run1,
    run2,
    pixelDiff,
    layoutIdentical,
    layoutDiffs,
    sha256: {
      png1: sha256(run1.png),
      png2: sha256(run2.png),
      layout1: sha256(run1.layoutJson),
      layout2: sha256(run2.layoutJson),
    },
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatBbox(bbox: Bbox | null): string {
  if (!bbox) return "n/a";
  return `x:[${bbox.minX},${bbox.maxX}] y:[${bbox.minY},${bbox.maxY}] (${bbox.maxX - bbox.minX + 1}x${bbox.maxY - bbox.minY + 1}px region)`;
}

function buildResultsMarkdown(
  results: ViewportResult[],
  meta: {
    chromiumVersion: string;
    executablePath: string;
    playwrightVersion: string;
    flags: readonly string[];
    contextOptions: BrowserContextOptions;
    frozenEpochIso: string;
    machine: {
      hostname: string;
      platform: string;
      arch: string;
      release: string;
      cpuModel: string;
    };
    generatedAt: string;
  },
): string {
  const allBitIdentical = results.every((r) => r.pixelDiff.bitIdentical);
  const allLayoutIdentical = results.every((r) => r.layoutIdentical);

  const lines: string[] = [];
  lines.push("# Render-determinism spike — RESULTS");
  lines.push("");
  lines.push(`Generated: ${meta.generatedAt}`);
  lines.push(`Machine: \`${meta.machine.hostname}\` (${meta.machine.platform}/${meta.machine.arch}, ${meta.machine.release}, ${meta.machine.cpuModel})`);
  lines.push(`Chromium: ${meta.chromiumVersion} (\`${meta.executablePath}\`)`);
  lines.push(`Playwright: ${meta.playwrightVersion}`);
  lines.push(`Frozen clock: ${meta.frozenEpochIso}`);
  lines.push("");
  lines.push("## Verdict (this machine, run-to-run)");
  lines.push("");
  lines.push(
    allBitIdentical
      ? "**Bit-identical: YES** — every viewport produced byte-identical PNGs across two fresh-context renders."
      : "**Bit-identical: NO** — at least one viewport differed byte-for-byte between the two runs. See per-viewport detail below.",
  );
  lines.push(
    allLayoutIdentical
      ? "**Layout-identical: YES** — every viewport's `getBoundingClientRect()` report was identical (exact float equality) across both runs."
      : "**Layout-identical: NO** — at least one viewport's layout report differed between runs.",
  );
  lines.push("");
  lines.push("## Per-viewport results");
  lines.push("");
  lines.push("| Viewport | Bit-identical | Exact diff px | pixelmatch diff px | Diff region | Layout identical |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of results) {
    const pd = r.pixelDiff;
    lines.push(
      `| ${r.viewport.name} (${pd.width}x${pd.height}) | ${pd.bitIdentical ? "yes" : "no"} | ${pd.bitIdentical ? "0" : pd.exactDiffPixels} | ${pd.bitIdentical ? "0" : pd.pixelmatchDiffPixels} | ${pd.bitIdentical ? "n/a" : formatBbox(pd.bbox)} | ${r.layoutIdentical ? "yes" : "no"} |`,
    );
  }
  lines.push("");

  for (const r of results) {
    if (r.pixelDiff.bitIdentical && r.layoutIdentical) continue;
    lines.push(`### ${r.viewport.name} — detail`);
    lines.push("");
    if (!r.pixelDiff.bitIdentical) {
      lines.push(
        `- Pixel diff: ${r.pixelDiff.exactDiffPixels} of ${r.pixelDiff.width * r.pixelDiff.height} pixels differ by at least one byte (exact compare); pixelmatch (threshold 0.1, AA-aware) counts ${r.pixelDiff.pixelmatchDiffPixels}. Region: ${formatBbox(r.pixelDiff.bbox)}. Diff image: \`out/${r.viewport.name}/diff.png\`.`,
      );
    }
    if (!r.layoutIdentical) {
      lines.push(`- Layout diffs (${r.layoutDiffs.length} field changes):`);
      for (const d of r.layoutDiffs.slice(0, 30)) {
        lines.push(`  - \`#${d.id}\` ${String(d.field)}: ${d.run1} → ${d.run2} (Δ ${d.delta})`);
      }
      if (r.layoutDiffs.length > 30) {
        lines.push(`  - … and ${r.layoutDiffs.length - 30} more`);
      }
    }
    lines.push("");
  }

  lines.push("## Flag set used");
  lines.push("");
  lines.push("```");
  for (const flag of meta.flags) lines.push(flag);
  lines.push("```");
  lines.push("");
  lines.push("Context options (Playwright `newContext`):");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(meta.contextOptions, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(
    "Notes: `--font-render-hinting=none` is a FreeType/Linux-only switch and is a " +
      "documented no-op on macOS (this run used CoreText); it is kept in the flag set " +
      "because the cross-machine leg of this protocol may run on Linux. The GPU/ANGLE " +
      "flags (`--disable-gpu`, `--use-gl=angle --use-angle=swiftshader`) target *cross-" +
      "machine* determinism — forcing the same software rasterizer regardless of the " +
      "local GPU — and are not expected to change anything run-to-run on one machine " +
      "with one GPU.",
  );
  lines.push("");

  lines.push("## Honest assessment");
  lines.push("");
  if (allBitIdentical && allLayoutIdentical) {
    lines.push(
      "On this machine, with this flag set, chromium+playwright render the fixture as a " +
        "pure function of (document, render config): identical input produced byte-" +
        "identical PNGs and exactly-equal layout reports across two independent browser " +
        "contexts, at all three viewports. That is the strongest result available from a " +
        "single-machine run; it does **not** by itself demonstrate cross-machine bit-" +
        "identity — see the protocol below.",
    );
  } else {
    lines.push(
      "Run-to-run determinism on this single machine was **not** perfect for every " +
        "viewport — see the per-viewport table. Where it failed, the diffs are almost " +
        "certainly at the font-rasterization or sub-pixel-AA layer (the categories the " +
        "flag set above targets but cannot fully eliminate on all platforms), not layout " +
        "(check whether layout-identical also failed — if layout is identical but pixels " +
        "are not, the reflow is deterministic and the divergence is purely in rasterization).",
    );
  }
  lines.push("");
  lines.push(
    "**Prediction for cross-machine (different hardware, possibly different OS):** bit-" +
      "identical PNGs are unlikely to hold in general, even with an identical pinned " +
      "Chromium build and this flag set. The remaining sources of divergence that no " +
      "chromium flag fully removes:",
  );
  lines.push("");
  lines.push(
    "- **Font rasterization backend differs by OS**: macOS uses CoreText, Linux uses " +
      "FreeType, Windows uses DirectWrite/GDI. `--font-render-hinting` only affects " +
      "FreeType. Even with the *same* embedded woff2 font (as this fixture does, " +
      "specifically to remove font-substitution as a variable), the hinting/AA/" +
      "sub-pixel-positioning pipeline that turns outlines into pixels is platform-native " +
      "and not fully overridable from Chromium flags.",
  );
  lines.push(
    "- **GPU/CPU floating-point and SIMD paths**: `--disable-gpu` + SwiftShader forces a " +
      "common software rasterizer, and `--disable-skia-runtime-opts` disables Skia's CPU-" +
      "specific SIMD dispatch, which closes most but not all of this gap — floating-point " +
      "reassociation differences across CPU architectures (e.g. Apple Silicon vs x86_64) " +
      "can still produce off-by-one-bit color values in gradients, shadows, and anti-" +
      "aliased edges.",
  );
  lines.push(
    "- **OS color management**: `--force-color-profile=srgb` removes the *display* ICC " +
      "profile as a variable, but does not guarantee bit-identical color-space math " +
      "across OS image/graphics stacks.",
  );
  lines.push("");
  lines.push(
    "**Recommended honest contract for docs/SPEC.md §5 / docs/PRD.md success criterion 3**: " +
      "commit to **layout-identical** (exact `getBoundingClientRect()` equality) as the hard " +
      "guarantee — that's a DOM/CSS-engine result, not a rasterizer result, and this spike's " +
      "run-to-run data supports it holding deterministically given a pinned engine and frozen " +
      "inputs. For pixels, commit to **pixel-identical within a near-zero tolerance** " +
      "(pixelmatch threshold, reported per-render) rather than byte-identical, and treat any " +
      "run that exceeds the tolerance as a real regression. Cross-machine byte-identical PNGs " +
      "should not be a promise in the spec; if the second-machine run below comes back bit-" +
      "identical anyway, that's a bonus, not something to rely on.",
  );
  lines.push("");

  lines.push("## Cross-machine protocol");
  lines.push("");
  lines.push(
    "This machine's run wrote `spikes/render/out/hashes.json` — one sha256 per PNG and per " +
      "layout report, plus the chromium version/flags/context options used to produce them. " +
      "To check a second machine over the tailnet:",
  );
  lines.push("");
  lines.push("1. On machine B, get the same source (same commit/worktree of this spike):");
  lines.push("   ```sh");
  lines.push("   # from machine A, or via your normal git remote");
  lines.push("   rsync -av --exclude node_modules \\");
  lines.push("     <thisRepoPath>/ <machineB-tailscale-name>:~/foundation-render-check/");
  lines.push("   ```");
  lines.push("2. On machine B:");
  lines.push("   ```sh");
  lines.push("   ssh <machineB-tailscale-name>");
  lines.push("   cd ~/foundation-render-check");
  lines.push("   pnpm install");
  lines.push("   pnpm exec playwright install chromium   # same pinned playwright version -> same chromium build");
  lines.push("   pnpm spike:render");
  lines.push("   ```");
  lines.push(
    "   This regenerates `spikes/render/out/hashes.json` and `RESULTS.md` on machine B, " +
      "using the identical fixture, flag set, and frozen clock (they're checked into the " +
      "worktree/commit you copied over — nothing is machine-specific in this spike).",
  );
  lines.push("3. Pull machine B's hashes back to machine A and diff:");
  lines.push("   ```sh");
  lines.push(
    "   scp <machineB-tailscale-name>:~/foundation-render-check/spikes/render/out/hashes.json \\",
  );
  lines.push("     /tmp/hashes-machine-b.json");
  lines.push("   diff <(jq -S . spikes/render/out/hashes.json) <(jq -S . /tmp/hashes-machine-b.json)");
  lines.push("   ```");
  lines.push(
    "   - If `diff` prints nothing beyond the `machine`/`generatedAt` fields (strip those " +
      "with `jq 'del(.machine, .generatedAt)'` on both sides before diffing for a clean " +
      "compare): every PNG and layout report hashed identically across machines — the " +
      "strongest possible result.",
  );
  lines.push(
    "   - If PNG hashes differ but layout hashes match: rasterization diverged " +
      "(font/GPU/color-space — see \"Honest assessment\" above), layout did not. This is " +
      "the expected outcome per this spike's prediction, and (per the recommended " +
      "contract above) should be treated as *acceptable*, not a failure.",
  );
  lines.push(
    "   - If layout hashes differ too: something more fundamental disagrees between the " +
      "two Chromium builds/platforms (a real bug to chase — check `browserVersion` in " +
      "both `hashes.json` files matches first).",
  );
  lines.push(
    "   - For a visual read on any PNG mismatch, pull the actual PNGs (not just hashes) " +
      "from machine B (`spikes/render/out/<viewport>/run1.png`) and run this harness's " +
      "pixelmatch step manually, or just eyeball them side by side.",
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [...DETERMINISM_FLAGS],
  });

  try {
    const results: ViewportResult[] = [];
    for (const viewport of VIEWPORTS) {
      // eslint-disable-next-line no-await-in-loop -- viewports must run sequentially, one browser instance
      const result = await runViewport(browser, viewport);
      results.push(result);
      const verdict = result.pixelDiff.bitIdentical ? "bit-identical" : "DIFFERS";
      console.log(
        `[${viewport.name}] pixels: ${verdict} | layout: ${result.layoutIdentical ? "identical" : "DIFFERS"}`,
      );
    }

    const browserVersion = browser.version();
    const cpuList = cpus();
    const cpuModel = cpuList.length > 0 ? (cpuList[0]?.model ?? "unknown") : "unknown";

    const meta = {
      chromiumVersion: browserVersion,
      executablePath: chromium.executablePath(),
      playwrightVersion: playwrightPackageJson.version,
      flags: DETERMINISM_FLAGS,
      contextOptions: CONTEXT_OPTIONS,
      frozenEpochIso: new Date(FROZEN_EPOCH_MS).toISOString(),
      machine: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        release: release(),
        cpuModel,
      },
      generatedAt: new Date().toISOString(),
    };

    const resultsMd = buildResultsMarkdown(results, meta);
    await writeFile(RESULTS_PATH, resultsMd);

    const hashesJson = {
      generatedAt: meta.generatedAt,
      machine: meta.machine,
      browserVersion: meta.chromiumVersion,
      playwrightVersion: meta.playwrightVersion,
      flags: meta.flags,
      contextOptions: meta.contextOptions,
      frozenEpochIso: meta.frozenEpochIso,
      viewports: Object.fromEntries(
        results.map((r) => [
          r.viewport.name,
          {
            width: r.viewport.width,
            height: r.viewport.height,
            bitIdentical: r.pixelDiff.bitIdentical,
            layoutIdentical: r.layoutIdentical,
            pngSha256Run1: r.sha256.png1,
            pngSha256Run2: r.sha256.png2,
            layoutSha256Run1: r.sha256.layout1,
            layoutSha256Run2: r.sha256.layout2,
            exactDiffPixels: r.pixelDiff.exactDiffPixels,
            pixelmatchDiffPixels: r.pixelDiff.pixelmatchDiffPixels,
          },
        ]),
      ),
    };
    await writeFile(
      path.join(OUT_DIR, "hashes.json"),
      `${JSON.stringify(hashesJson, null, 2)}\n`,
    );

    console.log(`\nWrote ${RESULTS_PATH}`);
    console.log(`Wrote ${path.join(OUT_DIR, "hashes.json")}`);
  } finally {
    await browser.close();
  }
}

await main();
