/**
 * Hand-built FdnDocument fixtures for chain module tests. Deliberately does
 * NOT import from src/parse/ (may not exist yet) — the chain module only
 * needs to round-trip whatever shape of FdnDocument it is handed.
 */
import type { FdnDocument, FdnNode } from '../src/types.js'

export function el(id: string, tag: string, overrides: Partial<FdnNode> = {}): FdnNode {
  return { id, tag, attrs: {}, style: {}, styleStates: {}, children: [], ...overrides }
}

export function baseDocument(): FdnDocument {
  return {
    specVersion: '0.1.0',
    title: 'Test Document',
    tokens: { 'color-brand': '#123456', 'space-md': '16px' },
    params: [{ name: 'variant', type: 'enum', values: ['a', 'b'], default: 'a' }],
    data: [{ name: 'items', items: [{ id: 1 }, { id: 2 }] }],
    lookups: [{ name: 'sizes', entries: { sm: '8px', lg: '24px' } }],
    states: [{ name: 'default', assignments: { variant: 'a' } }],
    viewports: [{ name: 'desktop', width: 1440, height: 900 }],
    matrix: [{ state: 'default', viewport: 'desktop' }],
    namedStyles: [{ name: 'card', style: { padding: '16px' }, styleStates: {} }],
    components: [{ name: 'Button', props: [{ name: 'label', type: 'string' }], slots: [], body: [] }],
    body: [
      el('n-root', 'div', {
        attrs: { class: 'app' },
        style: { display: 'flex' },
        styleStates: { hover: { color: 'red' } },
        children: [
          el('n-child-1', 'span', { text: 'hello' }),
          el('n-child-2', 'p', { attrs: { id: 'p2' }, style: { color: 'blue' } }),
        ],
      }),
      el('n-second-root', 'footer', { text: 'bye' }),
    ],
  }
}
