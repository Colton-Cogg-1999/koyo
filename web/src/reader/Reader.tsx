import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, Copy, Headphones, Maximize2, Minimize2, PanelRight, PenLine, Search, Sparkles, Trash2, Type, X } from 'lucide-react';
import { api } from '../api';
import { player, usePlayer } from '../audio';
import { navigate } from '../route';
import { clearSession, publishSession, type Location } from '../session';
import { defaultPrefs, type Annotation, type BookDetail, type Color, type ReaderPrefs } from '../types';
import { failure, Pane, toast, useAsync } from '../ui';
import { Agent } from './Agent';
import { Margin, type MarginTab } from './Margin';
import { PdfView } from './PdfView';
import { ReflowView, type Jump, type NotePositions, type Picked } from './ReflowView';

const COLORS: Color[] = ['blue', 'green', 'pink', 'yellow'];
const NO_ANNOTATIONS: Annotation[] = [];

function samePositions(a: NotePositions, b: NotePositions) {
  if (a.size !== b.size) return false;
  for (const [id, at] of a) {
    const other = b.get(id);
    if (other?.x !== at.x || other?.y !== at.y) return false;
  }
  return true;
}
const PAPERS: ReaderPrefs['paper'][] = ['term', 'ivory', 'sepia'];
const FONTS: { id: ReaderPrefs['font']; label: string }[] = [
  { id: 'mono', label: 'JetBrains' },
  { id: 'newsreader', label: 'Newsreader' },
  { id: 'literata', label: 'Literata' },
  { id: 'sans', label: 'Sans' },
];

export function Reader({ id, startBlock, focus, setFocus }: { id: string; startBlock: number | null; focus: boolean; setFocus: (on: boolean) => void }) {
  const [book, , setBook] = useAsync(() => api.book(id), [id]);
  const [annotations, reloadAnnotations, setAnnotations] = useAsync(() => api.annotations({ book: id }), [id]);
  const [prefs, setPrefs] = useState<ReaderPrefs>(defaultPrefs);
  const [location, setLocation] = useState<Location>({ block: 0, fraction: 0, page: 1, ratio: 0 });
  const [jump, setJump] = useState<Jump | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [editing, setEditing] = useState<{ annotation: Annotation; rect: DOMRect } | null>(null);
  const [typeOpen, setTypeOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);
  const [tab, setTab] = useState<MarginTab>('margin');
  const [askSeed, setAskSeed] = useState<{ selection: string; block: number; endBlock: number; question?: string; nonce: number } | null>(null);
  const [notePositions, setNotePositions] = useState<NotePositions>(new Map());
  const audio = usePlayer();
  const saveTimer = useRef(0);
  const pendingPosition = useRef<Location | null>(null);
  const nonce = useRef(1);
  const mark = audio.book === id ? audio.mark : null;

  useEffect(() => {
    api.settings().then((s) => s.reader && setPrefs({ ...defaultPrefs, ...(s.reader as Partial<ReaderPrefs>) })).catch(() => {});
  }, []);

  const go = useCallback((block: number, flash = true) => {
    setJump({ block, flash, nonce: ++nonce.current });
  }, []);

  useEffect(() => {
    if (!book) return;
    const saved = book.position;
    if (startBlock !== null) setJump({ block: startBlock, flash: true, nonce: ++nonce.current });
    else if (saved) setJump({ block: saved.block, page: saved.page || undefined, fraction: saved.fraction, nonce: ++nonce.current });
    else setJump({ block: 0, fraction: 0, nonce: ++nonce.current });
    setLocation((l) => ({ ...l, ratio: saved?.progress ?? 0, page: saved?.page || 1 }));
    void player.load(book.id, book.title).catch(() => {});
  }, [book?.id, startBlock]);

  const flushPosition = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    const latest = pendingPosition.current;
    if (!latest) return;
    pendingPosition.current = null;
    void api.savePosition(id, latest.block, latest.fraction, latest.page).catch(failure);
  }, [id]);

  useEffect(() => {
    window.addEventListener('pagehide', flushPosition);
    return () => { window.removeEventListener('pagehide', flushPosition); flushPosition(); };
  }, [flushPosition]);

  const onLocation = useCallback((block: number, fraction: number, page: number, ratio: number, endBlock?: number, visibleStart?: number) => {
    setLocation({ block, fraction, page, ratio, endBlock, visibleStart });
    pendingPosition.current = { block, fraction, page, ratio };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushPosition, 700);
  }, [flushPosition]);

  const onNotes = useCallback((next: NotePositions) => {
    setNotePositions((current) => (samePositions(current, next) ? current : next));
  }, []);

  const listenFrom = useCallback(async (block: number) => {
    const status = await api.tts();
    if (!status.installed) return toast('Install the voice engine in the audiobook pane first.');
    const summary = await api.audio(id);
    const started = await api.startAudio(id, summary.status === 'none' ? status.default_voice : summary.voice!, block);
    await player.load(id, book?.title ?? '');
    await player.refresh();
    if (started.tracks?.length) await player.playBlock(block);
  }, [id, book?.title]);

  const seek = useCallback((ratio: number) => {
    if (!book) return;
    const last = book.sections.at(-1)?.last_block ?? 0;
    if (book.format === 'pdf') setJump({ block: -1, page: Math.max(1, Math.round(ratio * book.pages)), fraction: 0, nonce: ++nonce.current });
    else go(Math.round(ratio * last), false);
  }, [book, go, id]);

  useEffect(() => publishSession({ book, location, go, seek, listenFrom }), [book, location, go, seek, listenFrom]);
  useEffect(() => clearSession, []);

  const changePrefs = (patch: Partial<ReaderPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    void api.saveSettings({ reader: next }).catch(failure);
  };

  const highlight = async (color: Color, note = '') => {
    if (!picked) return null;
    const created = await api.createAnnotation({ book_id: id, kind: 'highlight', color, anchor: picked.anchor, block: picked.block, page: picked.page, quote: picked.quote, note });
    setAnnotations((list) => [...(list ?? []), created]);
    window.getSelection()?.removeAllRanges();
    setPicked(null);
    return created;
  };

  const startNote = async () => {
    const rect = picked?.rect;
    const created = await highlight('blue').catch(failure);
    if (created && rect) setEditing({ annotation: created, rect });
  };

  const askAbout = (question?: string) => {
    if (!picked) return;
    setAskSeed({ selection: picked.quote, block: picked.block, endBlock: picked.anchor.kind === 'text' ? picked.anchor.endBlock : (picked.endBlock ?? picked.block), question, nonce: ++nonce.current });
    setSideOpen(true);
    window.getSelection()?.removeAllRanges();
    setPicked(null);
  };

  const listenHere = async () => {
    if (!picked) return;
    const block = picked.block;
    window.getSelection()?.removeAllRanges();
    setPicked(null);
    await listenFrom(block);
  };

  const bookmarks = useMemo(() => (annotations ?? []).filter((a) => a.kind === 'bookmark'), [annotations]);
  const here = bookmarks.find((b) => (book?.format === 'pdf' ? b.page === location.page : b.block === location.block));

  const toggleBookmark = async () => {
    if (here) {
      await api.deleteAnnotation(here.id);
      setAnnotations((list) => (list ?? []).filter((a) => a.id !== here.id));
    } else {
      const anchor = { kind: 'bookmark', block: location.block, page: location.page };
      const created = await api.createAnnotation({ book_id: id, kind: 'bookmark', anchor, block: location.block, page: location.page, quote: chapterTitle(book, location.block) });
      setAnnotations((list) => [...(list ?? []), created]);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,[contenteditable]') || event.ctrlKey || event.metaKey || event.altKey) return;
      const chapters = book?.chapters ?? [];
      const current = chapters.findLastIndex((c) => c.start <= location.block);
      switch (event.key) {
        case 'f': setFocus(!focus); break;
        case '\\': setSideOpen((open) => !open); break;
        case 't': setSideOpen(true); setTab('index'); break;
        case 'm': setSideOpen(true); setTab('margin'); break;
        case 'n': setSideOpen(true); setTab('notebook'); break;
        case 'b': void toggleBookmark().catch(failure); break;
        case 'l': player.toggle(); break;
        case ']': if (chapters[current + 1]) go(chapters[current + 1].start, false); break;
        case '[': if (chapters[Math.max(0, current - 1)]) go(chapters[Math.max(0, current - 1)].start, false); break;
        case 'Escape':
          setTypeOpen(false);
          setEditing(null);
          if (focus) setFocus(false);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!book || !jump) return <div className="reader-loading">loading…</div>;
  if (book.status !== 'ready') {
    return <div className="reader-loading">{book.status === 'failed' ? book.error : 'indexing…'}</div>;
  }

  const props = { book, prefs, annotations: annotations ?? NO_ANNOTATIONS, jump, mark, onLocation, onPick: setPicked, onNotes,
    onJump: (block: number) => go(block, false),
    onHit: (annotation: Annotation, rect: DOMRect) => setEditing({ annotation, rect }) };
  const chapter = chapterTitle(book, location.block);

  return (
    <div className={`reader ${focus ? 'zen' : ''}`}>
      <Pane
        className="volume"
        title={<>{book.title}{chapter && <i> // {chapter}</i>}</>}
        tools={
          <>
            <button className="icon" title="Library" onClick={() => navigate('library')}><ArrowLeft size={16} /></button>
            <button className="icon" title="Search (/)" onClick={() => window.dispatchEvent(new CustomEvent('oma-search', { detail: { book: id } }))}><Search size={15} /></button>
            <button className={`icon ${typeOpen ? 'on' : ''}`} title="Text and page" onClick={() => setTypeOpen(!typeOpen)}><Type size={15} /></button>
            <button className={`icon ${here ? 'on' : ''}`} title="Bookmark (b)" onClick={() => void toggleBookmark().catch(failure)}><Bookmark size={15} fill={here ? 'currentColor' : 'none'} /></button>
            <button className={`icon ${sideOpen ? 'on' : ''}`} title="Side panes (\)" onClick={() => setSideOpen(!sideOpen)}><PanelRight size={15} /></button>
            <button className="icon" title="Zen mode (f)" onClick={() => setFocus(!focus)}>{focus ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          </>
        }
      >
        <div className="volume-body">
          {book.format === 'pdf' ? <PdfView {...props} /> : <ReflowView {...props} />}
          {book.chars === 0 && <div className="scanned-note">Scanned book with no text layer. Reading works; notes, Oma and audio need text.</div>}
          {typeOpen && <TypePanel prefs={prefs} pdf={book.format === 'pdf'} onChange={changePrefs} onClose={() => setTypeOpen(false)} />}
        </div>
        {picked && (
          <div className="pick-menu" style={menuPosition(picked.rect)} onMouseDown={(event) => event.preventDefault()}>
            {COLORS.map((color) => <button key={color} className={`swatch ${color}`} title={`Highlight ${color}`} onClick={() => void highlight(color).catch(failure)} />)}
            <i />
            <button title="Add a note" onClick={() => void startNote()}><PenLine size={15} /></button>
            <button title="Ask Oma" onClick={() => askAbout()}><Sparkles size={15} /></button>
            <button title="Explain this" className="text" onClick={() => askAbout('Explain this passage.')}>explain</button>
            <button title="Listen from here" onClick={() => void listenHere().catch(failure)}><Headphones size={15} /></button>
            <button title="Copy" onClick={() => void navigator.clipboard.writeText(picked.quote).then(() => toast('copied'))}><Copy size={14} /></button>
          </div>
        )}
      </Pane>

      {sideOpen && !focus && (
        <div className="side">
          <Margin
            book={book}
            annotations={annotations ?? NO_ANNOTATIONS}
            positions={notePositions}
            block={location.block}
            bookmarks={bookmarks}
            tab={tab}
            setTab={setTab}
            go={go}
            reload={reloadAnnotations}
            onEdit={(annotation, rect) => setEditing({ annotation, rect })}
          />
          <Agent book={book} location={location} seed={askSeed} go={go} />
        </div>
      )}

      {editing && (
        <NoteEditor
          key={editing.annotation.id}
          annotation={editing.annotation}
          rect={editing.rect}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            const updated = await api.updateAnnotation(editing.annotation.id, patch);
            setAnnotations((list) => (list ?? []).map((a) => (a.id === updated.id ? updated : a)));
            setEditing((current) => (current ? { ...current, annotation: updated } : current));
            setBook((current) => current);
          }}
          onDelete={async () => {
            await api.deleteAnnotation(editing.annotation.id);
            setAnnotations((list) => (list ?? []).filter((a) => a.id !== editing.annotation.id));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function chapterTitle(book: BookDetail | null, block: number) {
  return book?.chapters.findLast((c) => c.start <= block)?.title ?? '';
}

function menuPosition(rect: DOMRect) {
  const top = rect.top > 90 ? rect.top - 50 : rect.bottom + 10;
  const left = Math.max(12, Math.min(window.innerWidth - 340, rect.left + rect.width / 2 - 150));
  return { top, left };
}

function TypePanel({ prefs, pdf, onChange, onClose }: { prefs: ReaderPrefs; pdf: boolean; onChange: (patch: Partial<ReaderPrefs>) => void; onClose: () => void }) {
  return (
    <aside className="type-panel">
      <header>
        <h3>DISPLAY</h3>
        <button className="icon" onClick={onClose} title="Close"><X size={15} /></button>
      </header>
      <div className="choices">
        {PAPERS.map((paper) => (
          <button key={paper} className={prefs.paper === paper ? 'on' : ''} onClick={() => onChange({ paper })}>{paper}</button>
        ))}
      </div>
      {pdf ? (
        <label>zoom <output>{Math.round(prefs.zoom * 100)}%</output>
          <input type="range" min={0.6} max={2} step={0.05} value={prefs.zoom} onChange={(event) => onChange({ zoom: Number(event.target.value) })} />
        </label>
      ) : (
        <>
          <div className="choices two">
            {FONTS.map((font) => (
              <button key={font.id} className={`font-${font.id} ${prefs.font === font.id ? 'on' : ''}`} onClick={() => onChange({ font: font.id })}>{font.label}</button>
            ))}
          </div>
          <label>size <output>{prefs.size}px</output>
            <input type="range" min={13} max={28} value={prefs.size} onChange={(event) => onChange({ size: Number(event.target.value) })} />
          </label>
          <label>leading <output>{prefs.leading.toFixed(2)}</output>
            <input type="range" min={1.3} max={2} step={0.02} value={prefs.leading} onChange={(event) => onChange({ leading: Number(event.target.value) })} />
          </label>
          <label>measure <output>{prefs.width}em</output>
            <input type="range" min={28} max={60} value={prefs.width} onChange={(event) => onChange({ width: Number(event.target.value) })} />
          </label>
        </>
      )}
    </aside>
  );
}

function NoteEditor({ annotation, rect, onClose, onSave, onDelete }: {
  annotation: Annotation;
  rect: DOMRect;
  onClose: () => void;
  onSave: (patch: { color?: string; note?: string }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [note, setNote] = useState(annotation.note);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  const close = async () => {
    if (note !== annotation.note) await onSave({ note }).catch(failure);
    onClose();
  };
  const top = Math.max(60, Math.min(window.innerHeight - 270, rect.bottom + 10));
  const left = Math.max(14, Math.min(window.innerWidth - 400, rect.left - 40));
  return (
    <div className="note-editor" style={{ top, left }}>
      <blockquote>{annotation.quote}</blockquote>
      <textarea
        ref={box}
        value={note}
        placeholder=">>> note"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void close();
          if (event.key === 'Escape') {
            event.stopPropagation();
            void close();
          }
        }}
      />
      <footer>
        {COLORS.map((color) => (
          <button key={color} className={`swatch ${color} ${annotation.color === color ? 'on' : ''}`} title={color} onClick={() => void onSave({ color }).catch(failure)} />
        ))}
        <span />
        <button className="icon" title="Remove" onClick={() => void onDelete().catch(failure)}><Trash2 size={15} /></button>
        <button className="solid" onClick={() => void close()}>save</button>
      </footer>
    </div>
  );
}
