import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, Maximize2, Minimize2, PanelRight, PenLine, Search, Sparkles, Trash2, Type } from 'lucide-react';
import { api } from '../api';
import { player, usePlayer } from '../audio';
import { navigate } from '../route';
import { clearSession, publishSession, type Location } from '../session';
import { defaultPrefs, type Annotation, type BookDetail, type Color, type ReaderPrefs } from '../types';
import { failure, Pane, toast, useAsync } from '../ui';
import { useLocalPreference, editingTarget, readerCommand } from '../preferences';
import { ReadingProgress } from './ReadingProgress';
import { ReaderSidebar } from './ReaderSidebar';
import { TypePanel } from './TypePanel';
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
export function Reader({ id, startBlock, startPage, focus, setFocus }: { id: string; startBlock: number | null; startPage: number | null; focus: boolean; setFocus: (on: boolean) => void }) {
  const [loadError, setLoadError] = useState(false);
  const [book, , setBook] = useAsync(() => api.book(id).catch((error) => { setLoadError(true); throw error; }), [id]);
  const [annotations, reloadAnnotations, setAnnotations] = useAsync(() => api.annotations({ book: id }), [id]);
  const [prefs, setPrefs] = useState<ReaderPrefs>(defaultPrefs);
  const [location, setLocation] = useState<Location>({ block: 0, fraction: 0, page: 1, ratio: 0 });
  const [jump, setJump] = useState<Jump | null>(null);
  const [contextMark, setContextMark] = useState<Annotation | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [editing, setEditing] = useState<{ annotation: Annotation; rect: DOMRect } | null>(null);
  const [typeOpen, setTypeOpen] = useState(false);
  const [sideOpen, setSideOpen] = useLocalPreference('sidebar-open', window.innerWidth > 1040);
  const [tab, setTab] = useState<MarginTab>('margin');
  const [askSeed, setAskSeed] = useState<{ selection: string; block: number; endBlock: number; question?: string; nonce: number } | null>(null);
  const [notePositions, setNotePositions] = useState<NotePositions>(new Map());
  const audio = usePlayer();
  const saveTimer = useRef(0);
  const pendingPosition = useRef<Location | null>(null);
  const nonce = useRef(1);
  const [returnTo, setReturnTo] = useState<Location | null>(null);
  const [undoMark, setUndoMark] = useState<Annotation | null>(null);
  const currentLocation = useRef(location);
  currentLocation.current = location;
  const mark = audio.book === id ? audio.mark : null;

  useEffect(() => {
    const refresh = () => reloadAnnotations();
    window.addEventListener('oma-annotations-changed', refresh);
    return () => window.removeEventListener('oma-annotations-changed', refresh);
  }, []);

  useEffect(() => {
    api.settings().then((s) => s.reader && setPrefs({ ...defaultPrefs, ...(s.reader as Partial<ReaderPrefs>) })).catch(() => {});
  }, []);

  const go = useCallback((block: number, flash = true, page?: number) => {
    setReturnTo(currentLocation.current);
    setJump({ block, flash, page: page || undefined, nonce: ++nonce.current });
  }, []);

  useEffect(() => {
    if (!book) return;
    const saved = book.position;
    if (startBlock !== null) setJump({ block: startBlock, page: startPage || undefined, flash: true, nonce: ++nonce.current });
    else if (saved) setJump({ block: saved.block, page: saved.page || undefined, fraction: saved.fraction, nonce: ++nonce.current });
    else setJump({ block: 0, fraction: 0, nonce: ++nonce.current });
    setLocation((l) => ({ ...l, ratio: saved?.progress ?? 0, page: saved?.page || 1 }));
    void player.load(book.id, book.title).catch(() => {});
  }, [book?.id, startBlock, startPage]);

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
    setJump({ block: location.block, page: location.page || undefined, fraction: location.fraction, nonce: ++nonce.current });
    setPrefs(next);
    void api.saveSettings({ reader: next }).catch(failure);
  };

  const highlight = async (color: Color, note = '') => {
    if (!picked) return null;
    const existing = annotations?.find((a) => a.kind === 'highlight' && a.block === picked.block && a.quote === picked.quote && JSON.stringify(JSON.parse(a.anchor), Object.keys(picked.anchor).sort()) === JSON.stringify(picked.anchor, Object.keys(picked.anchor).sort()));
    if (existing) { setPicked(null); return existing; }
    const created = await api.createAnnotation({ book_id: id, kind: 'highlight', color, anchor: picked.anchor, block: picked.block, page: picked.page, quote: picked.quote, note });
    setAnnotations((list) => [...(list ?? []), created]);
    window.getSelection()?.removeAllRanges();
    setPicked(null);
    return created;
  };

  const startNote = async () => {
    const rect = picked?.rect;
    const created = await highlight('green').catch(failure);
    if (created && rect) setEditing({ annotation: created, rect });
  };

  const askAbout = () => {
    if (!picked) return;
    setContextMark({ id: 'ask-context', book_id: id, kind: 'highlight', color: 'green', anchor: JSON.stringify(picked.anchor), block: picked.block, page: picked.page, quote: picked.quote, note: '', created_at: Date.now(), updated_at: Date.now() });
    setAskSeed({ selection: picked.quote, block: picked.block, endBlock: picked.anchor.kind === 'text' ? picked.anchor.endBlock : (picked.endBlock ?? picked.block), nonce: ++nonce.current });
    setSideOpen(true);
    readerCommand('focus-chat');
    window.getSelection()?.removeAllRanges();
    setPicked(null);
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
      if (editingTarget(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.key.toLowerCase() === 'd') { event.preventDefault(); void toggleBookmark().catch(failure); }
        if (event.key.toLowerCase() === 'b') { event.preventDefault(); setSideOpen((v) => !v); }
        if (event.key.toLowerCase() === 'j') { event.preventDefault(); setSideOpen(true); readerCommand('focus-chat'); }
        return;
      }
      if (event.altKey) return;
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

  useEffect(() => {
    const command = (event: Event) => {
      switch ((event as CustomEvent<string>).detail) {
        case 'bookmark': void toggleBookmark().catch(failure); break;
        case 'sidebar': setSideOpen((v) => !v); break;
        case 'toggle-notes': case 'toggle-chat': case 'focus-chat': setSideOpen(true); break;
        case 'chapters': setSideOpen(true); setTab('index'); break;
        case 'appearance': setTypeOpen((v) => !v); break;
        case 'ask-selection': askAbout(); break;
      }
    };
    window.addEventListener('oma-reader-command', command);
    return () => window.removeEventListener('oma-reader-command', command);
  });
  useEffect(() => {
    if (!undoMark) return;
    const timer = window.setTimeout(() => setUndoMark(null), 6000);
    return () => window.clearTimeout(timer);
  }, [undoMark]);

  if (loadError) return <div className="reader-loading">This book could not be opened. <button className="ghost" onClick={() => navigate('library')}>Back to Library</button></div>;
  if (!book || !jump) return <div className="reader-loading">loading…</div>;
  if (book.status !== 'ready') {
    return <div className="reader-loading">{book.status === 'failed' ? book.error : 'indexing…'}</div>;
  }

  const props = { book, prefs, annotations: contextMark ? [...(annotations ?? []), contextMark] : annotations ?? NO_ANNOTATIONS, jump, mark, onLocation, onPick: setPicked, onNotes,
    onJump: (block: number) => go(block, false),
    onHit: (annotation: Annotation, rect: DOMRect) => { if (annotation.id !== 'ask-context') setEditing({ annotation, rect }); } };
  const chapter = chapterTitle(book, location.block);

  return (
    <div className={`reader ${focus ? 'zen' : ''}`}>
      <Pane
        className="volume"
        title={<>{book.title}<i> · {chapter && chapter !== book.title ? `${chapter} · ` : ''}{Math.round(location.ratio * 100)}%</i></>}
        tools={
          <>
            <button className="icon" title="Library" onClick={() => navigate('library')}><ArrowLeft size={16} /></button>
            <button className="icon" title="Search (Ctrl+F)" onClick={() => window.dispatchEvent(new CustomEvent('oma-search', { detail: { book: id } }))}><Search size={15} /></button>
            <button className={`icon ${typeOpen ? 'on' : ''}`} title="Text and page" onClick={() => setTypeOpen(!typeOpen)}><Type size={15} /></button>
            <button className={`icon ${here ? 'on' : ''}`} title="Bookmark (Ctrl+D)" onClick={() => void toggleBookmark().catch(failure)}><Bookmark size={15} fill={here ? 'currentColor' : 'none'} /></button>
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
            <button title="Highlight" onClick={() => void highlight('green').then((a) => a && !annotations?.some((old) => old.id === a.id) && setUndoMark(a)).catch(failure)}>Highlight</button>
            <button title="Add a note" onClick={() => void startNote()}><PenLine size={14} /> Note</button>
            <button title="Ask Oma" onClick={() => askAbout()}><Sparkles size={14} /> Ask</button>
          </div>
        )}
        {undoMark && <div className="highlight-undo" role="status">Highlight saved <button className="tab" onClick={() => void api.deleteAnnotation(undoMark.id).then(() => { setAnnotations((list) => list?.filter((a) => a.id !== undoMark.id) ?? []); setUndoMark(null); }).catch(failure)}>Undo</button></div>}
        <ReadingProgress book={book} location={location} seek={(ratio) => { setReturnTo(location); seek(ratio); }} back={returnTo ? () => { setJump({ block: returnTo.block, page: returnTo.page || undefined, fraction: returnTo.fraction, nonce: ++nonce.current }); setReturnTo(null); } : undefined} />
      </Pane>

      {(
        <ReaderSidebar open={sideOpen && !focus} onClose={() => setSideOpen(false)} notes={<Margin
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
          />} chat={<Agent book={book} location={location} seed={askSeed} go={go} onSelectionClear={() => setContextMark(null)} />} />
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
  const top = Math.max(8, Math.min(window.innerHeight - 52, rect.top > 90 ? rect.top - 50 : rect.bottom + 10));
  const left = Math.max(12, Math.min(window.innerWidth - 340, rect.left + rect.width / 2 - 150));
  return { top, left };
}


function NoteEditor({ annotation, rect, onClose, onSave, onDelete }: {
  annotation: Annotation;
  rect: DOMRect;
  onClose: () => void;
  onSave: (patch: { color?: string; note?: string }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const draftKey = `omareader:passage-draft:${annotation.book_id}:${annotation.id}`;
  const [note, setNote] = useState(() => {
    try { return localStorage.getItem(draftKey) ?? annotation.note; } catch { return annotation.note; }
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const changeNote = (value: string) => {
    setNote(value);
    try { localStorage.setItem(draftKey, value); } catch { setError('Draft could not be stored locally. Save before closing.'); }
  };
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  const close = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      if (note !== annotation.note) await onSave({ note });
      try { localStorage.removeItem(draftKey); } catch { /* the server has saved it */ }
      onClose();
    } catch (error) {
      setError(`Save failed: ${(error as Error).message}. Your draft is kept here.`);
    } finally { setSaving(false); }
  };
  const top = Math.max(60, Math.min(window.innerHeight - 270, rect.bottom + 10));
  const left = Math.max(14, Math.min(window.innerWidth - 400, rect.left - 40));
  return (
    <div className="note-editor" style={{ top, left }}>
      <blockquote>{annotation.quote}</blockquote>
      <textarea
        ref={box}
        value={note}
        placeholder="Write a note…"
        disabled={saving}
        onChange={(event) => changeNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void close();
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      />
      {error && <p className="error" role="status">{error}</p>}
      <footer>
        {COLORS.map((color) => (
          <button key={color} className={`swatch ${color} ${annotation.color === color ? 'on' : ''}`} title={color} onClick={() => void onSave({ color }).catch(failure)} />
        ))}
        <span />
        <button className="icon" title="Remove" disabled={saving} onClick={() => { if (window.confirm('Delete this annotation and its note?')) void onDelete().then(() => localStorage.removeItem(draftKey)).catch(failure); }}><Trash2 size={15} /></button>
        <button className="tab" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="solid" disabled={saving} onClick={() => void close()}>{saving ? 'saving…' : 'save'}</button>
      </footer>
    </div>
  );
}
