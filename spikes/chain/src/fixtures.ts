/**
 * Shared, deterministic test fixtures: a ~30-node base tree used by the
 * gauntlet, the perf run, and the harness tests. Node ids are fixed strings
 * (never generated with Math.random/Date.now) so runs are reproducible and
 * canonical() comparisons across peers/libraries are meaningful.
 */

import type { FdnNode } from './contract.js'

function el(
  id: string,
  tag: string,
  props: Record<string, string>,
  styles: Record<string, string>,
  children: FdnNode[] = [],
): FdnNode {
  return { id, tag, props, styles, children }
}

function textNode(id: string, value: string): FdnNode {
  return { id, tag: 'text', props: {}, styles: {}, text: value, children: [] }
}

/**
 * A ~30-node document: root > 4 sections > 3 children each > a text leaf
 * each, plus a couple of extras to round out the count.
 */
export function buildBaseTree(): FdnNode {
  const sections = ['header', 'main', 'aside', 'footer'].map((sectionTag, si) => {
    const sid = `n-${sectionTag}`
    const kids: FdnNode[] = []
    for (let ci = 0; ci < 3; ci++) {
      const cid = `${sid}-c${ci}`
      const leafId = `${cid}-text`
      kids.push(
        el(
          cid,
          ci === 0 ? 'div' : ci === 1 ? 'span' : 'p',
          { class: `item-${si}-${ci}` },
          { color: ci % 2 === 0 ? '#111' : '#222' },
          [textNode(leafId, `${sectionTag} item ${ci}`)],
        ),
      )
    }
    return el(sid, 'section', { class: sectionTag }, { display: 'block' }, kids)
  })

  return el('n-root', 'html', { lang: 'en' }, {}, [
    el('n-head', 'head', {}, {}, [el('n-title', 'title', {}, {}, [textNode('n-title-text', 'Foundation')])]),
    el('n-body', 'body', { class: 'app' }, { margin: '0' }, sections),
  ])
}

export function countNodes(node: FdnNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0)
}

/**
 * A deterministic ~`targetCount`-node bushy tree for the perf run (S1).
 * Purely counter-driven (no PRNG needed) so the fixture itself is trivially
 * reproducible; perf.ts uses a seeded PRNG only to decide which *existing*
 * node an operation targets, never to shape this fixture.
 */
export function buildBigTree(targetCount: number, idPrefix = 'p'): FdnNode {
  const root: FdnNode = { id: `${idPrefix}0`, tag: 'div', props: { role: 'root' }, styles: {}, children: [] }
  const nodes: FdnNode[] = [root]
  let parentPointer = 0
  for (let i = 1; i < targetCount; i++) {
    const parent = nodes[parentPointer % nodes.length] as FdnNode
    const node: FdnNode = {
      id: `${idPrefix}${i}`,
      tag: i % 7 === 0 ? 'span' : 'div',
      props: { idx: String(i) },
      styles: { color: i % 2 === 0 ? '#111' : '#222' },
      children: [],
    }
    parent.children.push(node)
    nodes.push(node)
    if (i % 3 === 0) parentPointer++
  }
  return root
}
