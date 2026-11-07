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
  let left = offset;
  const nodes = textNodes(block);
  for (const node of nodes) {
    if (left <= node.length) return [node, left];
    left -= node.length;
  }
  const last = nodes.at(-1);
  return last ? [last, last.length] : null;
}

export function anchorFromSelection(selection: Selection): { anchor: TextAnchor; quote: string; rect: DOMRect } | null {
  if (selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const quote = selection.toString().replace(/\s+/g, ' ').trim();
  const startBlock = blockOf(range.startContainer);
  const endBlock = blockOf(range.endContainer);
  if (!quote || !startBlock || !endBlock) return null;
  const anchor: TextAnchor = {
    kind: 'text',
    startBlock: Number(startBlock.dataset.b),
    startOffset: offsetIn(startBlock, range.startContainer, range.startOffset),
    endBlock: Number(endBlock.dataset.b),
    endOffset: offsetIn(endBlock, range.endContainer, range.endOffset),
  };
  return { anchor, quote, rect: range.getBoundingClientRect() };
}

export function rangeFor(root: HTMLElement, anchor: TextAnchor) {
  const start = root.querySelector<HTMLElement>(`[data-b="${anchor.startBlock}"]`);
  const end = root.querySelector<HTMLElement>(`[data-b="${anchor.endBlock}"]`);
  if (!start || !end) return null;
  const from = pointAt(start, anchor.startOffset);
  const to = pointAt(end, anchor.endOffset);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from[0], from[1]);
  range.setEnd(to[0], to[1]);
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
      const range = anchor?.kind === 'text' ? rangeFor(root, anchor) : null;
      if (range) ranges.push(range);
    }
    setHighlight(`oma-${color}`, ranges);
  }
}

export function paintReading(root: HTMLElement | null, mark: { block: number; start: number; end: number } | null) {
  const block = mark && root?.querySelector<HTMLElement>(`[data-b="${mark.block}"]`);
  if (!block || !mark) return void CSS.highlights.delete('oma-reading');
  const from = pointAt(block, mark.start);
  const to = pointAt(block, mark.end);
  if (!from || !to) return void CSS.highlights.delete('oma-reading');
  const range = document.createRange();
  range.setStart(from[0], from[1]);
  range.setEnd(to[0], to[1]);
  setHighlight('oma-reading', [range]);
}

export function clearPaint() {
  for (const color of COLORS) CSS.highlights.delete(`oma-${color}`);
  CSS.highlights.delete('oma-reading');
}

/** Finds the highlight under a click, since painted ranges have no elements to target. */
export function annotationAt(x: number, y: number, annotations: Annotation[]) {
  const caret = document.caretPositionFromPoint?.(x, y);
  if (!caret) return null;
  const block = blockOf(caret.offsetNode);
  if (!block) return null;
  const seq = Number(block.dataset.b);
  const offset = offsetIn(block, caret.offsetNode, caret.offset);
  const compare = (b1: number, o1: number, b2: number, o2: number) => (b1 - b2) || (o1 - o2);
  return annotations.find((annotation) => {
    const anchor = parseAnchor(annotation);
    if (annotation.kind !== 'highlight' || anchor?.kind !== 'text') return false;
    return compare(anchor.startBlock, anchor.startOffset, seq, offset) <= 0 && compare(seq, offset, anchor.endBlock, anchor.endOffset) <= 0;
  }) ?? null;
}
