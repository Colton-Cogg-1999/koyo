import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { urls } from '../api';
import { forget, saveLocal, stored } from '../preferences';
import type { Annotation, BookDetail, Color } from '../types';
import { failure, Sun } from '../ui';
import { parseAnchor } from './anchors';

export const COLORS: Color[] = ['yellow', 'pink', 'green', 'blue'];

/** Highlights and notes in reading order. "Notes" shows passages you wrote about (and saved
 * answers); "Highlights" shows every marked passage. Editing happens here and only here. */
export function Notes({ mode, book, annotations, focus, go, onUpdate, onDelete }: {
  mode: 'notes' | 'highlights';
  book: BookDetail;
  annotations: Annotation[];
  focus: { id: string; nonce: number } | null;
  go: (block: number, flash?: boolean, page?: number) => void;
  onUpdate: (id: string, patch: { color?: Color; note?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  // Once a note is listed it stays listed while the tab is open, so clearing its text to
  // rewrite it doesn't make the card vanish mid-edit.
  const shown = useRef(new Set<string>());
  const groups = useMemo(() => {
    const list = annotations.filter((a) => a.kind === 'highlight' && (mode === 'highlights' || a.note || a.id === focus?.id || shown.current.has(a.id) || stored(`note-draft:${a.id}`, ''))).sort((a, b) => a.block - b.block || a.created_at - b.created_at);
    const map = new Map<string, Annotation[]>();
    for (const item of list) {
      shown.current.add(item.id);
      const chapter = book.chapters.findLast((c) => c.start <= item.block)?.title ?? '';
      map.set(chapter, [...(map.get(chapter) ?? []), item]);
    }
    return [...map];
  }, [annotations, book.chapters, mode, focus?.id]);
  const count = groups.reduce((n, [, items]) => n + items.length, 0);

  return (
    <>
      <div className="panel-scroll notes">
        {count > 0 && (
          <div className="notes-bar">
            <span>{count} {mode === 'notes' ? (count === 1 ? 'note' : 'notes') : (count === 1 ? 'highlight' : 'highlights')}</span>
            <a className="ghost small" href={urls.notesMarkdown(book.id)} download title="Export highlights and notes as Markdown"><Download size={13} /> Markdown</a>
          </div>
        )}
        {groups.map(([chapter, items]) => (
          <section key={chapter}>
            {chapter && <h3 className="eyebrow">{chapter}</h3>}
            {items.map((item) => (
              <NoteItem key={item.id} item={item} focused={focus?.id === item.id ? focus.nonce : 0} go={go} onUpdate={onUpdate} onDelete={onDelete} />
            ))}
          </section>
        ))}
        {!count && (
          <div className="panel-empty">
            <p>{mode === 'notes' ? 'Select a passage and choose Note to write beside it. Saved answers appear here too.' : 'Select any passage and pick a colour to highlight it.'}</p>
            <p className="hint">Everything stays on this device and is mirrored as Markdown files.</p>
          </div>
        )}
      </div>
    </>
  );
}

function NoteItem({ item, focused, go, onUpdate, onDelete }: {
  item: Annotation;
  focused: number;
  go: (block: number, flash?: boolean, page?: number) => void;
  onUpdate: (id: string, patch: { color?: Color; note?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const draftKey = `note-draft:${item.id}`;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => stored(draftKey, item.note));
  const [status, setStatus] = useState<'' | 'saving' | 'failed'>('');
  const box = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const timer = useRef(0);
  const latest = useRef(text);
  const saved = useRef(item.note);
  const answer = parseAnchor(item)?.kind === 'bookmark';

  useEffect(() => {
    if (!focused) return;
    setEditing(true);
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);
  useEffect(() => { if (editing) field.current?.focus(); }, [editing]);
  useEffect(() => { saved.current = item.note; }, [item.note]);

  const save = async () => {
    window.clearTimeout(timer.current);
    const value = latest.current;
    if (value === saved.current) { forget(draftKey); return; }
    setStatus('saving');
    try {
      await onUpdate(item.id, { note: value });
      saved.current = value;
      forget(draftKey);
      setStatus('');
    } catch (error) {
      setStatus('failed');
      failure(error);
    }
  };
  useEffect(() => () => { window.clearTimeout(timer.current); if (latest.current !== saved.current) void save(); }, []);

  const change = (value: string) => {
    setText(value);
    latest.current = value;
    saveLocal(draftKey, value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 700);
  };

  return (
    <article ref={box} className={`note ${item.color} ${editing ? 'editing' : ''}`}>
      <button className="note-quote" onClick={() => go(item.block, true, answer ? item.page : undefined)} title="Show in book">
        {answer && <span className="note-kind"><Sun size={8} /> Saved answer</span>}
        <span>{item.quote}</span>
      </button>
      {editing ? (
        <>
          <textarea ref={field} aria-label="Note" rows={3} value={text} placeholder="Write a note…"
            onChange={(e) => change(e.target.value)}
            onBlur={() => { void save(); }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.stopPropagation(); void save(); setEditing(false); }
            }} />
          <footer>
            {COLORS.map((color) => (
              <button key={color} className={`dot ${color} ${item.color === color ? 'on' : ''}`} aria-label={`${color} highlight`} aria-pressed={item.color === color}
                onMouseDown={(e) => e.preventDefault()} onClick={() => void onUpdate(item.id, { color }).catch(failure)} />
            ))}
            <span className="grow" />
            <small className="status" role="status">{status === 'saving' ? 'Saving…' : status === 'failed' ? 'Not saved — kept on this device' : ''}</small>
            <button className="icon" title="Delete" aria-label="Delete highlight and note" onMouseDown={(e) => e.preventDefault()} onClick={() => {
              if (window.confirm('Delete this highlight and its note?')) void onDelete(item.id).then(() => forget(draftKey)).catch(failure);
            }}><Trash2 size={14} /></button>
            <button className="ghost small" onMouseDown={(e) => e.preventDefault()} onClick={() => { void save(); setEditing(false); }}>Done</button>
          </footer>
        </>
      ) : (
        <button className={`note-text ${text ? '' : 'empty'}`} onClick={() => setEditing(true)}>{text || 'Add a note'}</button>
      )}
    </article>
  );
}
