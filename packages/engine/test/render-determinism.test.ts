import { existsSync } from 'node:fs'
import { chromium } from 'playwright'
import { afterAll, describe, expect, it } from 'vitest'
import { closeBrowser } from '../src/render/browser.js'
import { renderHtml } from '../src/render/index.js'

function chromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

const HAS_CHROMIUM = chromiumAvailable()

// Proven property from spikes/render/RESULTS.md: given a pinned browser,
// fixed flags/context, a frozen clock, and animations off, the same
// (html, config) renders bit-identically run to run. Keep this fixture tiny
// (a couple of static elements, no fonts to wait on beyond the default UA
// stylesheet) so the test stays well under 10s including browser launch.
describe.skipIf(!HAS_CHROMIUM)('render: renderHtml determinism', () => {
  afterAll(async () => {
    await closeBrowser()
  })

  it('renders the same small html twice -> byte-identical png and identical layout', async () => {
    const html = `<!doctype html>
<html>
<head><style>
  body { margin: 0; }
  #box { width: 60px; height: 40px; background: #3355ff; }
  #label { font-family: monospace; font-size: 12px; }
</style></head>
<body>
  <div id="box"></div>
  <span id="label">hi</span>
</body>
</html>`
    const config = { viewport: { name: 'test', width: 200, height: 120 } }

    const r1 = await renderHtml(html, config)
    const r2 = await renderHtml(html, config)

    expect(Buffer.from(r1.png).equals(Buffer.from(r2.png))).toBe(true)
    expect(r1.layout).toEqual(r2.layout)
    expect(r1.layout.map((l) => l.id)).toEqual(['box', 'label'])
  }, 20000)
})
