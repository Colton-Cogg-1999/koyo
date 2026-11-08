import type { Annotation, TextAnchor } from '../types';

export function blockOf(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>('[data-b]') ?? null;
}

function textNodes(block: HTMLElement) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

/** Converts a DOM point into an offset within the block's text. */
export function offsetIn(block: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(block);
  range.setEnd(node, offset);
  return range.toString().length;
}

function pointAt(block: HTMLElement, offset: number): [Text, number] | null {
  if (!Number.isInteger(offset) || offset < 0) return null;
  let left = offset;
  const nodes = textNodes(block);
  for (const node of nodes) {
    if (left <= node.length) return [node, left];
    left -= node.length;
  }
  return null;
}

export function anchorFromSelection(selection: Selection): { anchor: TextAnchor; quote: string; rect: DOMRect } | null {
  if (selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  // The range's text follows the DOM. Selection text follows layout, which loses the space
  // after a floated drop cap ("Alibrary").
  const quote = range.toString().replace(/\s+/g, ' ').trim();
  const startBlock = blockOf(range.startContainer);
  const endBlock = blockOf(range.endContainer);
  if (!quote || !startBlock || !endBlock) return null;
  const anchor: TextAnchor = {
    kind: 'text',
    version: 1,
    exact: range.toString(),
    prefix: (startBlock.textContent ?? '').slice(Math.max(0, offsetIn(startBlock, range.startContainer, range.startOffset) - 48), offsetIn(startBlock, range.startContainer, range.startOffset)),
    suffix: (endBlock.textContent ?? '').slice(offsetIn(endBlock, range.endContainer, range.endOffset), offsetIn(endBlock, range.endContainer, range.endOffset) + 48),
    startBlock: Number(startBlock.dataset.b),
    startOffset: offsetIn(startBlock, range.startContainer, range.startOffset),
    endBlock: Number(endBlock.dataset.b),
    endOffset: offsetIn(endBlock, range.endContainer, range.endOffset),
  };
  return { anchor, quote, rect: range.getBoundingClientRect() };
}

const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();

export function rangeFor(root: HTMLElement, anchor: TextAnchor, quote?: string) {
  const start = root.querySelector<HTMLElement>(`[data-b="${anchor.startBlock}"]`);
  const end = root.querySelector<HTMLElement>(`[data-b="${anchor.endBlock}"]`);
  if (!start || !end) return null;
  const from = pointAt(start, anchor.startOffset);
  const to = pointAt(end, anchor.endOffset);
  const expected = anchor.exact ?? quote;
  if (from && to) {
    const range = document.createRange();
    range.setStart(from[0], from[1]);
    range.setEnd(to[0], to[1]);
    if (!range.collapsed && (!expected || normalized(range.toString()) === normalized(expected))) return range;
  }
  // Recover only an unambiguous match within the original block. Never guess
  // between repeated passages or silently clamp an obsolete position.
  if (start !== end || !expected) return null;
  const text = start.textContent ?? '';
  const matches: number[] = [];
  for (let at = text.indexOf(expected); at >= 0; at = text.indexOf(expected, at + 1)) {
    if (anchor.prefix && !text.slice(0, at).endsWith(anchor.prefix)) continue;
    if (anchor.suffix && !text.slice(at + expected.length).startsWith(anchor.suffix)) continue;
    matches.push(at);
  }
  if (matches.length !== 1) return null;
  const recoveredFrom = pointAt(start, matches[0]);
  const recoveredTo = pointAt(end, matches[0] + expected.length);
  if (!recoveredFrom || !recoveredTo) return null;
  const range = document.createRange();
  range.setStart(...recoveredFrom);
  range.setEnd(...recoveredTo);
  return range;
}

export function parseAnchor(annotation: Annotation) {
  try {
    return JSON.parse(annotation.anchor);
  } catch {
    return null;
  }
}

const COLORS = ['yellow', 'blue', 'green', 'pink'] as const;

function setHighlight(name: string, ranges: Range[]) {
  if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
}

/** Paints with the CSS Custom Highlight API, so the book's DOM is never rewritten. */
export function paintAnnotations(root: HTMLElement, annotations: Annotation[]) {
  for (const color of COLORS) {
    const ranges: Range[] = [];
    for (const annotation of annotations) {
      if (annotation.kind !== 'highlight' || annotation.color !== color) continue;
      const anchor = parseAnchor(annotation);
      const range = anchor?.kind === 'text' ? rangeFor(root, anchor, annotation.quote) : null;
      if (range) ranges.push(range);
    }
    setHighlight(`oma-${color}`, ranges);
  }
}

export function clearPaint() {
  for (const color of COLORS) CSS.highlights.delete(`oma-${color}`);
}

/** Finds the highlight under a click, since painted ranges have no elements to target. */
export function annotationAt(x: number, y: number, annotations: Annotation[]) {
  const caret = document.caretPositionFromPoint?.(x, y);
  if (!caret) return null;
  const block = blockOf(caret.offsetNode);
  if (!block) return null;
  const root = block.closest<HTMLElement>('.paper-body');
  if (!root) return null;
  return annotations.find((annotation) => {
    const anchor = parseAnchor(annotation);
    if (annotation.kind !== 'highlight' || anchor?.kind !== 'text') return false;
    const range = rangeFor(root, anchor, annotation.quote);
    return range?.isPointInRange(caret.offsetNode, caret.offset) ?? false;
  }) ?? null;
}
