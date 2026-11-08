import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Copy, Highlighter, MessageSquareText, NotebookText, Settings2, Sparkle, Trash2 } from 'lucide-react';
import { api } from '../api';
import { editingTarget, useLocalPreference } from '../preferences';
import { navigate } from '../route';
import { useTheme } from '../theme';
import { normalizePrefs, defaultPrefs, type Annotation, type Color, type ReaderPrefs, type ReadingLocation } from '../types';
import { Brand, failure, NAME, Sun, toast, TopBar, useAsync, useDismiss } from '../ui';
import { Appearance } from './Appearance';
import { Ask, type AskSeed } from './Ask';
import { Contents } from './Contents';
import { COLORS, Notes } from './Notes';
import { Tabs, type Tab } from './Panel';
import { ReflowView, type Jump, type Picked } from './ReflowView';

// pdf.js is large; EPUB readers never pay for it.
const PdfView = lazy(() => import('./PdfView').then((m) => ({ default: m.PdfView })));

type PanelName = Tab | 'contents';
const NONE: Annotation[] = [];

export function Reader({ id, startBlock, startPage }: { id: string; startBlock: number | null; startPage: number | null }) {
  const [loadError, setLoadError] = useState(false);
  const [book] = useAsync(() => api.book(id).catch((error) => { setLoadError(true); throw error; }), [id]);
  const [annotations, reloadAnnotations, setAnnotations] = useAsync(() => api.annotations({ book: id }), [id]);
  const [prefs, setPrefs] = useState<ReaderPrefs>(defaultPrefs);
  const [location, setLocation] = useState<ReadingLocation>({ block: 0, fraction: 0, page: 1, ratio: 0 });
  const [jump, setJump] = useState<Jump | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [hit, setHit] = useState<{ annotation: Annotation; rect: DOMRect } | null>(null);
  const [panel, setPanel] = useLocalPreference<PanelName | null>('panel', null);
  const [lastTab, setLastTab] = useLocalPreference<Tab>('tab', 'ask');
  const [askOpened, setAskOpened] = useState(panel === 'ask');
  const [focusNote, setFocusNote] = useState<{ id: string; nonce: number } | null>(null);
  const [askSeed, setAskSeed] = useState<AskSeed | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);
  const [appearance, setAppearance] = useState(false);
  const [returnTo, setReturnTo] = useState<ReadingLocation | null>(null);
  const { night } = useTheme();
  const nonce = useRef(1);
  const saveTimer = useRef(0);
  const pending = useRef<ReadingLocation | null>(null);
  const here = useRef(location);
  here.current = location;
  const appearanceBox = useRef<HTMLDivElement>(null);
  useDismiss(appearance, () => setAppearance(false), () => [appearanceBox.current]);

  useEffect(() => {
    api.settings().then((s) => setPrefs(normalizePrefs(s.reader))).catch(() => {});
  }, []);

  useEffect(() => {
    if (panel === 'ask') setAskOpened(true);
    if (panel && panel !== 'contents') setLastTab(panel);
  }, [panel]);

  const go = useCallback((block: number, flash = true, page?: number) => {
    setReturnTo(here.current);
    setJump({ block, flash, page: page || undefined, nonce: ++nonce.current });
    if (window.innerWidth < 900) setPanel(null);
  }, []);

  useEffect(() => {
    if (!book) return;
    const saved = book.position;
    if (startBlock !== null) setJump({ block: startBlock, page: startPage || undefined, flash: true, nonce: ++nonce.current });
    else if (saved) setJump({ block: saved.block, page: saved.page || undefined, fraction: saved.fraction, nonce: ++nonce.current });
    else setJump({ block: 0, fraction: 0, nonce: ++nonce.current });
    setLocation((l) => ({ ...l, ratio: saved?.progress ?? 0, page: saved?.page || 1 }));
  }, [book?.id, startBlock, startPage]);

  const flushPosition = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const latest = pending.current;
    if (!latest) return;
    pending.current = null;
    void api.savePosition(id, latest.block, latest.fraction, latest.page).catch(failure);
  }, [id]);

  useEffect(() => {
    window.addEventListener('pagehide', flushPosition);
    return () => { window.removeEventListener('pagehide', flushPosition); flushPosition(); };
  }, [flushPosition]);

  const onLocation = useCallback((block: number, fraction: number, page: number, ratio: number, endBlock?: number, visibleStart?: number) => {
    const next = { block, fraction, page, ratio, endBlock, visibleStart };
    setLocation(next);
    pending.current = next;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushPosition, 700);
  }, [flushPosition]);

  const seek = (ratio: number) => {
    if (!book) return;
    setReturnTo(here.current);
    if (book.format === 'pdf') setJump({ block: -1, page: Math.max(1, Math.round(ratio * book.pages)), fraction: 0, nonce: ++nonce.current });
    else setJump({ block: Math.round(ratio * (book.sections.at(-1)?.last_block ?? 0)), nonce: ++nonce.current });
  };

  const changePrefs = (patch: Partial<ReaderPrefs>) => {
    const next = { ...prefs, ...patch };
    setJump({ block: location.block, page: location.page || undefined, fraction: location.fraction, nonce: ++nonce.current });
    setPrefs(next);
    void api.saveSettings({ reader: next }).catch(failure);
  };

  const toggle = (name: PanelName) => setPanel((current) => (current === name ? null : name));
  const toggleCard = () => setPanel((current) => (current && current !== 'contents' ? null : lastTab));
  const dismissSelection = () => {
    setPicked(null);
    setHit(null);
    window.getSelection()?.removeAllRanges();
  };

  const createHighlight = async (color: Color) => {
    if (!picked) return null;
    const created = await api.createAnnotation({ book_id: id, kind: 'highlight', color, anchor: picked.anchor, block: picked.block, page: picked.page, quote: picked.quote, note: '' });
    setAnnotations((list) => [...(list ?? []), created]);
    return created;
  };

  const updateAnnotation = useCallback(async (annotationId: string, patch: { color?: Color; note?: string }) => {
    const updated = await api.updateAnnotation(annotationId, patch);
    setAnnotations((list) => (list ?? []).map((a) => (a.id === updated.id ? updated : a)));
  }, []);

  const deleteAnnotation = useCallback(async (annotationId: string) => {
    await api.deleteAnnotation(annotationId);
    setAnnotations((list) => (list ?? []).filter((a) => a.id !== annotationId));
  }, []);

  const onColor = (color: Color) => {
    if (hit) void updateAnnotation(hit.annotation.id, { color }).catch(failure);
    else void createHighlight(color).catch(failure);
    dismissSelection();
  };

  const onNote = async () => {
    const target = hit?.annotation ?? await createHighlight('yellow').catch((error) => { failure(error); return null; });
    dismissSelection();
    if (!target) return;
    setPanel('notes');
    setFocusNote({ id: target.id, nonce: ++nonce.current });
  };

  const onAsk = () => {
    const source = hit
      ? { selection: hit.annotation.quote, block: hit.annotation.block, endBlock: endOf(hit.annotation) }
      : picked && { selection: picked.quote, block: picked.block, endBlock: picked.anchor.kind === 'text' ? picked.anchor.endBlock : (picked.endBlock ?? picked.block) };
    dismissSelection();
    if (!source) return;
    setAskSeed({ ...source, nonce: ++nonce.current });
    setPanel('ask');
  };

  // A press anywhere but the bar dismisses it. Pointerdown comes before the click that may
  // open a highlight again, so reopening still works.
  useEffect(() => {
    if (!hit && !picked) return;
    const press = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.('.selection-bar')) setHit(null);
    };
    document.addEventListener('pointerdown', press);
    return () => document.removeEventListener('pointerdown', press);
  }, [hit, picked]);

    const chapters = book?.chapters ?? [];
  const chapterIndex = chapters.findLastIndex((c) => c.start <= location.block);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); setPanel('contents'); setSearchNonce((n) => n + 1); return; }
      if (mod && !event.altKey && event.key.toLowerCase() === 'j') { event.preventDefault(); setPanel('ask'); window.setTimeout(() => window.dispatchEvent(new Event('koyo-focus-ask')), 0); return; }
      if (event.key === 'Escape') {
        if (picked || hit) dismissSelection();
        else if (!editingTarget(event.target) && panel) setPanel(null);
        return;
      }
      if (editingTarget(event.target) || mod || event.altKey) return;
      switch (event.key) {
        case 'c': toggle('contents'); break;
        case 'n': toggle('notes'); break;
        case 'h': toggle('highlights'); break;
        case 'q': toggle('ask'); break;
        case '/': event.preventDefault(); setPanel('contents'); setSearchNonce((n) => n + 1); break;
        case ']': if (chapters[chapterIndex + 1]) go(chapters[chapterIndex + 1].start, false); break;
        case '[': if (chapters[Math.max(0, chapterIndex - 1)]) go(chapters[Math.max(0, chapterIndex - 1)].start, false); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (loadError) return <div className="reader-message">This book could not be opened. <button className="ghost" onClick={() => navigate('library')}>Back to the shelf</button></div>;
  if (!book || !jump) return <div className="reader-message"><Sun size={14} /></div>;
  if (book.status !== 'ready') return <div className="reader-message">{book.status === 'failed' ? book.error : 'Preparing this book…'}</div>;

  const list = annotations ?? NONE;
  const highlights = list.filter((a) => a.kind === 'highlight').length;
  const viewProps = {
    book, prefs, annotations: list, jump, night, onLocation,
    onPick: setPicked,
    onJump: (block: number) => go(block, false),
    onHit: (annotation: Annotation, rect: DOMRect) => { setPicked(null); setHit({ annotation, rect }); },
  };
  const toolbarRect = picked?.rect ?? hit?.rect;
  const current = hit?.annotation.color;

  return (
    <div className={`reader ${panel ? 'with-panel' : ''}`}>
      <TopBar>
        <Brand />
        <span className="rule" />
        <div className="book-title" title={`${book.title}${book.author ? ` — ${book.author}` : ''}`}>
          <strong>{book.title}</strong>{book.author && <span> — {book.author}</span>}
        </div>
        <span className="grow" />
        <nav className="reader-tools" aria-label="Reader tools">
          <button className={`icon ${panel === 'contents' ? 'on' : ''}`} title="Contents and search (c)" aria-label="Contents and search" aria-pressed={panel === 'contents'} onClick={() => toggle('contents')}><BookOpen size={21} strokeWidth={1.6} /></button>
          <button className={`icon ${panel && panel !== 'contents' ? 'on' : ''}`} title="Ask, notes and highlights" aria-label="Ask, notes and highlights" aria-pressed={!!panel && panel !== 'contents'} onClick={toggleCard}>
            <NotebookText size={21} strokeWidth={1.6} />{highlights > 0 && <b className="badge" aria-label={`${highlights} highlights`} />}
          </button>
          <span className="rule" />
          <div className="anchor" ref={appearanceBox}>
            <button className={`icon ${appearance ? 'on' : ''}`} title="Appearance" aria-label="Appearance" aria-expanded={appearance} onClick={() => setAppearance(!appearance)}><Settings2 size={20} strokeWidth={1.6} /></button>
            {appearance && <Appearance prefs={prefs} pdf={book.format === 'pdf'} onChange={changePrefs} />}
          </div>
        </nav>
      </TopBar>

      <div className="reader-body">
        <div className="page" style={{ '--column': book.format === 'pdf' ? `${Math.round(920 * prefs.zoom)}px` : `${prefs.width * prefs.size}px` } as React.CSSProperties}>
          <Suspense fallback={<div className="reader-message"><Sun size={14} /></div>}>
            {book.format === 'pdf' ? <PdfView {...viewProps} /> : <ReflowView {...viewProps} />}
          </Suspense>
          {book.chars === 0 && <div className="scanned-note">This is a scanned book with no text layer. It reads fine, but notes and questions need text.</div>}
          <footer className="progress">
            <span className="progress-where">
              {returnTo
                ? <button className="ghost small" onClick={() => { setJump({ block: returnTo.block, page: returnTo.page || undefined, fraction: returnTo.fraction, nonce: ++nonce.current }); setReturnTo(null); }}><ArrowLeft size={13} /> Back</button>
                : null}
              {chapterIndex >= 0 && chapters.length > 1 && <span className="progress-chapter" title={chapters[chapterIndex].title}>Chapter {chapterIndex + 1} of {chapters.length}</span>}
              {book.format === 'pdf' && <span>p. {location.page} of {book.pages}</span>}
            </span>
            <Scrubber ratio={location.ratio} onSeek={seek} />
            <span className="progress-percent">{Math.round(location.ratio * 100)}%</span>
          </footer>
        </div>

        {(panel || askOpened) && (
          <aside className={`panel panel-${panel}`} hidden={!panel} aria-label={panel === 'contents' ? 'Contents' : 'Reading companion'}>
            {panel === 'contents' && <Contents book={book} location={location} go={go} searchNonce={searchNonce} onClose={() => setPanel(null)} />}
            {panel && panel !== 'contents' && <Tabs tab={panel} onTab={setPanel} onClose={() => setPanel(null)} />}
            {(panel === 'notes' || panel === 'highlights') && <Notes mode={panel} book={book} annotations={list} focus={focusNote} go={go} onUpdate={updateAnnotation} onDelete={deleteAnnotation} />}
            {/* Ask stays mounted once opened, so a streaming answer or a draft survives switching tabs. */}
            {askOpened && <div className="tab-body" hidden={panel !== 'ask'}><Ask book={book} location={location} seed={askSeed} go={(block) => go(block)} onSaved={reloadAnnotations} /></div>}
          </aside>
        )}
      </div>

      {toolbarRect && (
        <div className={`selection-bar ${barPosition(toolbarRect).below ? 'below' : 'above'}`} role="toolbar" aria-label="Selection" style={barPosition(toolbarRect).style} onMouseDown={(e) => e.preventDefault()}>
          <button className="icon" title="Highlight" aria-label="Highlight" onClick={() => onColor(current ?? 'yellow')}><Highlighter size={17} /></button>
          {COLORS.map((color) => (
            <button key={color} className={`dot ${color} ${current === color ? 'on' : ''}`} title={`Highlight ${color}`} aria-label={`Highlight ${color}`} onClick={() => onColor(color)} />
          ))}
          <span className="rule" />
          <button onClick={() => void onNote()}><MessageSquareText size={16} /> Note</button>
          <button className="ask-action" onClick={onAsk}><Sparkle size={15} /> Ask {NAME}</button>
          {hit
            ? <button className="icon" title="Remove highlight" aria-label="Remove highlight" onClick={() => { const target = hit.annotation; dismissSelection(); void deleteAnnotation(target.id).catch(failure); }}><Trash2 size={16} /></button>
            : <button className="icon" title="Copy" aria-label="Copy passage" onClick={() => { const text = picked?.quote ?? ''; dismissSelection(); void navigator.clipboard.writeText(text).then(() => toast('Copied')).catch(failure); }}><Copy size={16} /></button>}
        </div>
      )}
    </div>
  );
}

function Scrubber({ ratio, onSeek }: { ratio: number; onSeek: (ratio: number) => void }) {
  const [scrub, setScrub] = useState<number | null>(null);
  const value = scrub ?? ratio;
  const commit = () => { if (scrub !== null) { onSeek(scrub); setScrub(null); } };
  return (
    <input className="scrubber" type="range" aria-label="Reading position" aria-valuetext={`${Math.round(value * 100)} percent`}
      min={0} max={10000} value={Math.round(value * 10000)} style={{ '--at': `${value * 100}%` } as React.CSSProperties}
      onChange={(e) => setScrub(Number(e.target.value) / 10000)} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
  );
}

function endOf(annotation: Annotation) {
  try {
    const anchor = JSON.parse(annotation.anchor);
    return anchor.kind === 'text' ? anchor.endBlock : annotation.block;
  } catch {
    return annotation.block;
  }
}

function barPosition(rect: DOMRect) {
  const width = 470;
  // Below the passage, as in a margin note; above only when there is no room underneath.
  const below = rect.bottom + 80 < window.innerHeight;
  const top = Math.max(70, below ? rect.bottom + 14 : rect.top - 66);
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
  // The pointer aims at the middle of the passage, wherever the bar had to sit.
  const caret = Math.max(22, Math.min(width - 22, rect.left + rect.width / 2 - left));
  return { below, style: { top, left, '--caret': `${caret}px` } as React.CSSProperties };
}

