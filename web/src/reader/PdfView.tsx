import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api, urls } from '../api';
import type { Annotation, BlockLocation } from '../types';
import { failure } from '../ui';
import { parseAnchor } from './anchors';
import type { NotePositions, ViewProps } from './ReflowView';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Rect = [number, number, number, number, number];

interface Overlay {
  page: number;
  rect: [number, number, number, number];
  kind: 'reading' | 'flash';
}

function PdfPage({ doc, number, width, ratio, live, annotations, overlays, night }: {
  doc: pdfjs.PDFDocumentProxy;
  number: number;
  width: number;
  ratio: number;
  live: boolean;
  annotations: Annotation[];
  overlays: Overlay[];
  night: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live || width <= 0) return;
    let cancelled = false;
    let render: pdfjs.RenderTask | null = null;
    let text: pdfjs.TextLayer | null = null;
    (async () => {
      const page = await doc.getPage(number);
      if (cancelled || !canvas.current || !textLayer.current) return;
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * dpr });
      canvas.current.width = viewport.width;
      canvas.current.height = viewport.height;
      render = page.render({ canvas: canvas.current, viewport });
      const container = textLayer.current;
      container.replaceChildren();
      container.style.setProperty('--total-scale-factor', String(scale));
      container.style.setProperty('--scale-factor', String(scale));
      text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale }) });
      await Promise.all([render.promise, text.render()]);
    })().catch((error) => {
      if (error?.name !== 'RenderingCancelledException') console.warn(error);
    });
    return () => {
      cancelled = true;
      render?.cancel();
      text?.cancel();
    };
  }, [doc, number, width, live]);

  const highlights = annotations.flatMap((annotation) => {
    const anchor = parseAnchor(annotation);
    if (anchor?.kind !== 'pdf') return [];
    return (anchor.rects as Rect[]).filter((r) => r[0] === number).map((r) => ({ id: annotation.id, color: annotation.color, r }));
  });

  return (
    <div className={`pdf-page ${night ? 'night' : ''}`} data-page={number} style={{ width, height: width * ratio }}>
      {live && <canvas ref={canvas} />}
      <div className="pdf-marks">
        {highlights.map(({ id, color, r }, i) => (
          <i key={`${id}-${i}`} className={`pdf-mark ${color}`} style={{ left: `${r[1] * 100}%`, top: `${r[2] * 100}%`, width: `${r[3] * 100}%`, height: `${r[4] * 100}%` }} />
        ))}
        {overlays.map((o, i) => (
          <i key={i} className={`pdf-${o.kind}`} style={{ left: `${o.rect[0] * 100}%`, top: `${o.rect[1] * 100}%`, width: `${o.rect[2] * 100}%`, height: `${o.rect[3] * 100}%` }} />
        ))}
      </div>
      {live && <div className="textLayer" ref={textLayer} />}
      <span className="pdf-number">{number}</span>
    </div>
  );
}

function mergeRects(rects: Rect[]) {
  const merged: Rect[] = [];
  for (const rect of rects) {
    const previous = merged.at(-1);
    const sameLine = previous && previous[0] === rect[0] && Math.abs(previous[2] - rect[2]) < 0.006 && rect[1] - (previous[1] + previous[3]) < 0.02;
    if (previous && sameLine) {
      const right = Math.max(previous[1] + previous[3], rect[1] + rect[3]);
      previous[3] = right - previous[1];
      previous[4] = Math.max(previous[4], rect[4]);
    } else {
      merged.push([...rect]);
    }
  }
  return merged;
}

export function PdfView({ book, prefs, annotations, jump, mark, onLocation, onPick, onHit, onNotes }: ViewProps) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [ratios, setRatios] = useState<number[]>([]);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(new Set([1]));
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const pagesBox = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const located = useRef(new Map<number, BlockLocation>());
  const pageBlocks = useRef(new Map<number, BlockLocation[]>());
  const applied = useRef(0);
  const readingAnchor = useRef<{page:number; fraction:number} | null>(null);
  const resizeAnchor = useRef<{page:number; fraction:number} | null>(null);
  const measuredWidth = useRef(0);
  const pageCount = doc?.numPages ?? book.pages;

  useEffect(() => {
    const task = pdfjs.getDocument({
      url: urls.file(book.id),
      wasmUrl: '/pdfjs/wasm/',
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      enableXfa: false,
    });
    task.promise
      .then(async (loaded) => {
        const dimensions: number[] = [];
        for (let n = 1; n <= loaded.numPages; n++) {
          const page = await loaded.getPage(n);
          const view = page.getViewport({ scale: 1 });
          dimensions.push(view.height / view.width);
        }
        setRatios(dimensions);
        setDoc(loaded);
      })
      .catch(failure);
    return () => void task.destroy();
  }, [book.id]);

  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const measure = () => {
      const next = Math.min(1400, Math.max(320, box.clientWidth - 112)) * prefs.zoom;
      if (next === measuredWidth.current) return;
      if (measuredWidth.current) resizeAnchor.current = readingAnchor.current;
      measuredWidth.current = next;
      setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [prefs.zoom]);

  const blocksOn = useCallback(async (page: number) => {
    const cached = pageBlocks.current.get(page);
    if (cached) return cached;
    const list = await api.pageBlocks(book.id, page);
    pageBlocks.current.set(page, list);
    return list;
  }, [book.id]);

  const report = useCallback(() => {
    frame.current = 0;
    const box = scroller.current;
    const holder = pagesBox.current;
    if (!box || !holder || !holder.children.length) return;
    const pages = Array.from(holder.children) as HTMLElement[];
    const readingLine = box.getBoundingClientRect().top + 24;
    const current = pages.find((p) => p.getBoundingClientRect().bottom > readingLine) ?? pages.at(-1)!;
    const bounds = current.getBoundingClientRect();
    const page = Number(current.dataset.page);
    const fraction = Math.max(0, Math.min(1, (readingLine - bounds.top) / bounds.height));
    readingAnchor.current = { page, fraction };
    const low = Math.max(1, page - 2);
    const high = Math.min(pageCount, page + 3);
    setVisible((current) => {
      if (current.has(low) && current.has(high) && current.size <= high - low + 1) return current;
      const next = new Set<number>();
      for (let n = low; n <= high; n++) next.add(n);
      return next;
    });
    const positions: NotePositions = new Map();
    for (const annotation of annotations) {
      const anchor = parseAnchor(annotation);
      if (!annotation.note || anchor?.kind !== 'pdf' || !anchor.rects.length) continue;
      const [at, x, y, w] = anchor.rects[0] as Rect;
      const bounds = pages[at - 1]?.getBoundingClientRect();
      if (bounds) positions.set(annotation.id, { x: bounds.left + (x + w) * bounds.width, y: bounds.top + y * bounds.height });
    }
    onNotes(positions);
    void blocksOn(page).then((list) => onLocation(list[0]?.seq ?? pageBlocks.current.get(page - 1)?.at(-1)?.seq ?? 0, fraction, page, (page - 1 + fraction) / Math.max(1, pageCount))).catch(() => {});
  }, [pageCount, blocksOn, onLocation, annotations, onNotes]);

  const scrollToPage = useCallback((page: number, fraction: number) => {
    const box = scroller.current;
    const holder = pagesBox.current;
    if (!box || !holder?.children.length) return;
    const element = holder.children[Math.max(0, Math.min(holder.children.length - 1, page - 1))] as HTMLElement;
    const rect = element.getBoundingClientRect();
    box.scrollTop += rect.top - box.getBoundingClientRect().top - 24 + fraction * rect.height;
  }, []);

  useLayoutEffect(() => {
    if (resizeAnchor.current) {
      scrollToPage(resizeAnchor.current.page, resizeAnchor.current.fraction);
      resizeAnchor.current = null;
    }
  }, [width, scrollToPage]);
  useEffect(report, [annotations, width, doc]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  useEffect(() => {
    if (!doc || width <= 0 || applied.current === jump.nonce) return;
    applied.current = jump.nonce;
    (async () => {
      if (jump.page || book.words === 0) {
        scrollToPage(jump.page || 1, jump.fraction ?? 0);
        report();
        return;
      }
      if (jump.block === -1) return;
      const target = await api.block(book.id, jump.block);
      located.current.set(jump.block, target);
      const offset = jump.fraction ?? Math.max(0, (target.y ?? 0) - 0.04);
      scrollToPage(target.page || 1, offset);
      if (jump.flash && target.x !== null) {
        const overlay: Overlay = { page: target.page, rect: [target.x, target.y!, target.w!, target.h!], kind: 'flash' };
        setOverlays((list) => [...list, overlay]);
        window.setTimeout(() => setOverlays((list) => list.filter((o) => o !== overlay)), 2400);
      }
      report();
    })().catch(failure);
  }, [doc, width, jump]);

  useEffect(() => {
    if (!mark) {
      setOverlays((list) => list.filter((o) => o.kind !== 'reading'));
      return;
    }
    let live = true;
    (async () => {
      const cached = located.current.get(mark.block) ?? (await api.block(book.id, mark.block));
      located.current.set(mark.block, cached);
      if (!live || cached.x === null) return;
      setOverlays((list) => [...list.filter((o) => o.kind !== 'reading'), { page: cached.page, rect: [cached.x!, cached.y!, cached.w!, cached.h!], kind: 'reading' }]);
      const box = scroller.current;
      const holder = pagesBox.current;
      const element = holder?.children[cached.page - 1];
      if (box && element) {
        const rect = element.getBoundingClientRect();
        const view = box.getBoundingClientRect();
        const top = rect.top + cached.y! * rect.height;
        if (top < view.top || top > view.bottom - 80) {
          box.scrollBy({ top: top - view.top - view.height * 0.25, behavior: 'smooth' });
        }
      }
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [mark?.block]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement).closest('input,textarea,select,button,[contenteditable],[role=dialog],[role=separator]')) return;
      const box = scroller.current;
      if (!box) return;
      if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
        event.preventDefault();
        box.scrollBy({ top: (event.shiftKey ? -1 : 1) * (box.clientHeight - 72), behavior: 'smooth' });
      } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        box.scrollBy({ top: -(box.clientHeight - 72), behavior: 'smooth' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onMouseUp = () => {
    window.setTimeout(async () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return onPick(null);
      const quote = selection.toString().replace(/\s+/g, ' ').trim();
      const range = selection.getRangeAt(0);
      const pages = Array.from(pagesBox.current?.children ?? []) as HTMLElement[];
      const rects: Rect[] = [];
      for (const client of Array.from(range.getClientRects())) {
        if (client.width < 1 || client.height < 1) continue;
        const middle = client.top + client.height / 2;
        const page = pages.find((p) => {
          const box = p.getBoundingClientRect();
          return middle >= box.top && middle <= box.bottom;
        });
        if (!page) continue;
        const box = page.getBoundingClientRect();
        rects.push([Number(page.dataset.page), (client.left - box.left) / box.width, (client.top - box.top) / box.height, client.width / box.width, client.height / box.height]);
      }
      const merged = mergeRects(rects);
      if (!quote || !merged.length) return onPick(null);
      const [page, , top] = merged[0];
      const blocks = await blocksOn(page).catch(() => []);
      const near = blocks.find((b) => (b.y ?? 0) + (b.h ?? 0) >= top) ?? blocks[0];
      const lastBlocks = await blocksOn(merged.at(-1)![0]).catch(() => []);
      onPick({ endBlock: lastBlocks.at(-1)?.seq ?? near?.seq ?? 0, anchor: { kind: 'pdf', rects: merged }, quote, rect: range.getBoundingClientRect(), block: near?.seq ?? 0, page });
    }, 0);
  };

  const onClick = (event: React.MouseEvent) => {
    if (!window.getSelection()?.isCollapsed) return;
    const page = (event.target as HTMLElement).closest<HTMLElement>('.pdf-page');
    if (!page) return;
    const box = page.getBoundingClientRect();
    const number = Number(page.dataset.page);
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const hit = annotations.find((annotation) => {
      const anchor = parseAnchor(annotation);
      return anchor?.kind === 'pdf' && (anchor.rects as Rect[]).some((r) => r[0] === number && x >= r[1] && x <= r[1] + r[3] && y >= r[2] && y <= r[2] + r[4]);
    });
    if (hit) onHit(hit, new DOMRect(event.clientX, event.clientY, 0, 0));
  };

  const numbers = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount]);

  return (
    <div
      className="stage pdf-stage"
      ref={scroller}
      onScroll={() => {
        frame.current ||= requestAnimationFrame(report);
      }}
    >
      <div className="pdf-pages" ref={pagesBox} onMouseUp={onMouseUp} onClick={onClick}>
        {doc && width > 0 && numbers.map((number) => (
          <PdfPage
            key={number}
            doc={doc}
            number={number}
            width={width}
            ratio={ratios[number - 1] ?? 1.414}
            live={visible.has(number)}
            annotations={annotations}
            overlays={overlays.filter((o) => o.page === number)}
            night={prefs.paper === 'term'}
          />
        ))}
      </div>
    </div>
  );
}
