import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Annotation, BookDetail, ReaderPrefs, TextAnchor } from '../types';
import { failure } from '../ui';
import { annotationAt, anchorFromSelection, clearPaint, paintAnnotations, parseAnchor, rangeFor } from './anchors';

export interface Picked {
  anchor: TextAnchor | { kind: 'pdf'; rects: [number, number, number, number, number][] };
  quote: string;
  endBlock?: number;
  rect: DOMRect;
  block: number;
  page: number;
}

export interface Jump {
  block: number;
  page?: number;
  fraction?: number;
  flash?: boolean;
  nonce: number;
}

export interface ViewProps {
  book: BookDetail;
  prefs: ReaderPrefs;
  annotations: Annotation[];
  jump: Jump;
  onLocation: (block: number, fraction: number, page: number, ratio: number, endBlock?: number, visibleStart?: number) => void;
  onPick: (picked: Picked | null) => void;
  onHit: (annotation: Annotation, rect: DOMRect) => void;
  onJump: (block: number) => void;
  night: boolean;
}

interface SectionData {
  idx: number;
  title: string;
  html: string;
  first_block: number;
  last_block: number;
}

/** Distance from the top of the viewport to the line that counts as "where you are". */
const READING_LINE = 64;

/** Memoized so a React update can never replace the DOM that highlights point into. */
const Prose = memo(function Prose({ html }: { html: string }) {
  return <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
});

export function ReflowView({ book, prefs, annotations, jump, onLocation, onPick, onHit, onJump }: ViewProps) {
  const [unresolved, setUnresolved] = useState(0);
  const [section, setSection] = useState<SectionData | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const blocks = useRef<HTMLElement[]>([]);
  const pending = useRef<Jump | null>(null);
  const frame = useRef(0);
  const readingAnchor = useRef<{ block: number; fraction: number } | null>(null);
  const measuredWidth = useRef(0);

  const sectionFor = useCallback(
    (block: number) => book.sections.find((s) => block >= s.first_block && block <= s.last_block) ?? book.sections[0],
    [book.sections],
  );

  const reveal = useCallback((target: Jump) => {
    const element = paper.current?.querySelector<HTMLElement>(`[data-b="${target.block}"]`);
    const box = scroller.current;
    if (!box) return;
    if (!element) {
      box.scrollTop = 0;
      return;
    }
    const top = element.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = top + element.offsetHeight * (target.fraction ?? 0) - READING_LINE;
    if (target.flash) {
      element.classList.remove('flash');
      void element.offsetWidth;
      element.classList.add('flash');
    }
  }, []);

  useEffect(() => {
    const target = sectionFor(jump.block);
    if (!target) return;
    if (section?.idx === target.idx) {
      reveal(jump);
      return;
    }
    pending.current = jump;
    let live = true;
    api.section(book.id, target.idx).then((data) => live && setSection(data)).catch(failure);
    return () => {
      live = false;
    };
  }, [jump]);

  const report = useCallback(() => {
    frame.current = 0;
    const box = scroller.current;
    const list = blocks.current;
    if (!box || !list.length) return;
    const width = paper.current?.clientWidth ?? 0;
    if (measuredWidth.current && width !== measuredWidth.current && readingAnchor.current) reveal({ ...readingAnchor.current, nonce: 0 });
    measuredWidth.current = width;
    const top = box.getBoundingClientRect().top + READING_LINE;
    let low = 0;
    let high = list.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (list[middle].getBoundingClientRect().bottom > top) high = middle;
      else low = middle + 1;
    }
    const element = list[low];
    const rect = element.getBoundingClientRect();
    const fraction = rect.height ? Math.max(0, (top - rect.top) / rect.height) : 0;
    const seq = Number(element.dataset.b);
    readingAnchor.current = { block: seq, fraction };
    const last = book.sections.at(-1)?.last_block ?? 1;
    const bottom = box.getBoundingClientRect().bottom;
    const visible = list.filter((b) => { const r = b.getBoundingClientRect(); return r.bottom > box.getBoundingClientRect().top && r.top < bottom; });
    onLocation(seq, fraction, 0, seq / Math.max(1, last), Number(visible.at(-1)?.dataset.b ?? seq), Number(visible[0]?.dataset.b ?? seq));
  }, [book.sections, onLocation]);

  useLayoutEffect(() => {
    if (!section || !paper.current) return;
    blocks.current = Array.from(paper.current.querySelectorAll<HTMLElement>('[data-b]'));
    const first = blocks.current.find((b) => b.tagName === 'P' && (b.textContent?.length ?? 0) > 120);
    first?.classList.add('dropcap');
    if (pending.current) {
      reveal(pending.current);
      pending.current = null;
    } else {
      scroller.current?.scrollTo(0, 0);
    }
    report();
  }, [section]);

  useLayoutEffect(() => {
    if (paper.current && section) {
      paintAnnotations(paper.current, annotations);
      setUnresolved(annotations.filter((a) => {
        const anchor = parseAnchor(a);
        return anchor?.kind === 'text' && anchor.startBlock >= section.first_block && anchor.startBlock <= section.last_block && !rangeFor(paper.current!, anchor, a.quote);
      }).length);
    }
  }, [annotations, section]);

  useEffect(() => () => { clearPaint(); cancelAnimationFrame(frame.current); }, []);


  useEffect(() => {
    const root = paper.current;
    if (!root) return;
    const observer = new ResizeObserver(() => report());
    observer.observe(root);
    return () => observer.disconnect();
  }, [report]);

  const onMouseUp = () => {
    window.setTimeout(() => {
      const selection = window.getSelection();
      const picked = selection && anchorFromSelection(selection);
      onPick(picked ? { ...picked, block: picked.anchor.startBlock, page: 0 } : null);
    }, 0);
  };

  const onClick = (event: React.MouseEvent) => {
    const link = (event.target as HTMLElement).closest('a');
    if (link) {
      event.preventDefault();
      const href = link.getAttribute('href') ?? '';
      if (href.startsWith('#b')) onJump(Number(href.slice(2)));
      else if (/^https?:|^mailto:/i.test(href)) void api.openExternal(href);
      return;
    }
    if (!window.getSelection()?.isCollapsed) return;
    const hit = annotationAt(event.clientX, event.clientY, annotations);
    if (hit) onHit(hit, new DOMRect(event.clientX, event.clientY, 0, 0));
  };

  const index = section ? book.sections.findIndex((s) => s.idx === section.idx) : -1;
  const chapterAt = section ? book.chapters.findIndex((c) => c.start >= section.first_block && c.start <= section.last_block) : -1;
  const ordinal = chapterAt >= 0 && !book.chapters[chapterAt].front ? book.chapters.slice(0, chapterAt + 1).filter((c) => !c.front).length : 0;
  const next = index >= 0 ? book.sections[index + 1] : undefined;
  const previous = index > 0 ? book.sections[index - 1] : undefined;

  useEffect(() => {
    const scrollPage = (direction: number) => {
      const box = scroller.current;
      if (!box) return;
      const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
      if (direction > 0 && atEnd && next) return onJump(next.first_block);
      if (direction < 0 && box.scrollTop <= 0 && previous) return onJump(previous.first_block);
      box.scrollBy({ top: direction * (box.clientHeight - 72), behavior: 'smooth' });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement).closest('input,textarea,select,button,[contenteditable],[role=dialog],[role=separator]')) return;
      if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
        event.preventDefault();
        scrollPage(event.shiftKey ? -1 : 1);
      } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        scrollPage(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, previous, onJump]);

  const style = {
    '--read-size': `${prefs.size}px`,
    '--read-leading': prefs.leading,
    '--read-width': `${prefs.width}em`,
  } as React.CSSProperties;

  return (
    <div
      className="stage"
      ref={scroller}
      onScroll={() => {
        frame.current ||= requestAnimationFrame(report);
      }}
    >
      {unresolved > 0 && <p className="annotation-warning" role="status">{unresolved} saved {unresolved === 1 ? 'passage' : 'passages'} could not be placed safely in this chapter. The notes are kept in the Notes panel; reselect the text to attach a new highlight.</p>}
      <article className={`paper font-${prefs.font}`} style={style}>
        <div className="paper-body" ref={paper} onMouseUp={onMouseUp} onClick={onClick}>
          {section && ordinal > 0 && <p className="chapter-eyebrow" aria-hidden="true">Chapter {ordinal}</p>}
          {section && <Prose html={section.html} />}
          {next ? (
            <button className="next-chapter" onClick={() => onJump(next.first_block)}>
              <span>Next</span>
              <strong>{next.title || 'Next section'}</strong>
            </button>
          ) : (
            section && <div className="the-end"><i className="sun" />The end</div>
          )}
        </div>
      </article>
    </div>
  );
}
