import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileText, Plus, Trash2 } from 'lucide-react';
import { api, urls } from '../api';
import type { Annotation, BookDetail, Note } from '../types';
import { failure, Pane, useAsync } from '../ui';
import type { NotePositions } from './ReflowView';

export type MarginTab = 'margin' | 'index' | 'notebook';

export function Margin({ book, annotations, positions, block, bookmarks, tab, setTab, go, reload, onEdit }: {
  book: BookDetail;
  annotations: Annotation[];
  positions: NotePositions;
  block: number;
  bookmarks: Annotation[];
  tab: MarginTab;
  setTab: (tab: MarginTab) => void;
  go: (block: number, flash?: boolean) => void;
  reload: () => void;
  onEdit: (annotation: Annotation, rect: DOMRect) => void;
}) {
  const tools = (['margin', 'index', 'notebook'] as MarginTab[]).map((name) => (
    <button key={name} className={`tab ${tab === name ? 'on' : ''}`} onClick={() => setTab(name)}>{name}</button>
  ));
  return (
    <Pane title="NOTES" tools={tools} className="margin-pane">
      {tab === 'margin' && <Refs book={book} annotations={annotations} positions={positions} onEdit={onEdit} />}
      {tab === 'index' && <Index book={book} block={block} bookmarks={bookmarks} go={go} />}
      {tab === 'notebook' && <NotesList book={book} annotations={annotations} reload={reload} go={go} />}
    </Pane>
  );
}

/** Notes float level with their passage, and a connector runs back to the text. */
function Refs({ book, annotations, positions, onEdit }: {
  book: BookDetail;
  annotations: Annotation[];
  positions: NotePositions;
  onEdit: (annotation: Annotation, rect: DOMRect) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [top, setTop] = useState(0);
  const [left, setLeft] = useState(0);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setTop(rect.top);
      setLeft(rect.left);
      setHeight(rect.height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const placed = annotations
    .filter((a) => a.note && positions.has(a.id))
    .map((a) => ({ note: a, y: positions.get(a.id)!.y - top, x: positions.get(a.id)!.x }))
    .filter((p) => p.y > -24 && p.y < height - 30)
    .sort((a, b) => a.y - b.y);

  let floor = 0;
  return (
    <div className="refs" ref={box}>
      {placed.map(({ note, y, x }) => {
        const at = Math.max(y, floor);
        floor = at + 22 + Math.ceil(note.note.length / 34) * 19 + 16;
        const chapter = book.chapters.findLast((c) => c.start <= note.block)?.title;
        return (
          <button key={note.id} className={`ref ${note.color}`} style={{ top: at }} onClick={(event) => onEdit(note, event.currentTarget.getBoundingClientRect())}>
            <span className="ref-line" style={{ width: Math.max(0, left + 22 - x), left: Math.min(0, x - left - 22) }} />
            <span>&gt;&gt;&gt; [REF: {chapter ?? `p. ${note.page}`}] {note.note}</span>
          </button>
        );
      })}
      {placed.length === 0 && <p className="hint">select text to highlight it or add a note. notes appear here, level with the passage.</p>}
    </div>
  );
}

function Index({ book, block, bookmarks, go }: { book: BookDetail; block: number; bookmarks: Annotation[]; go: (block: number, flash?: boolean) => void }) {
  const current = book.toc.findLastIndex((t) => t.block <= block);
  const active = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void active.current?.scrollIntoView({ block: 'center' });
  }, []);
  return (
    <div className="index">
      {book.toc.map((entry, i) => (
        <button key={entry.idx} ref={i === current ? active : undefined} className={`level-${Math.min(entry.level, 3)} ${i === current ? 'current' : ''}`} onClick={() => go(entry.block, false)}>
          <span>{entry.title}</span>
          {entry.page > 0 && <small>{entry.page}</small>}
        </button>
      ))}
      {book.toc.length === 0 && <p className="hint">no chapters found.</p>}
      {bookmarks.length > 0 && <h3>BOOKMARKS</h3>}
      {bookmarks.map((mark) => (
        <button key={mark.id} onClick={() => go(mark.block, false)}>
          <span>{mark.quote || 'bookmark'}</span>
          {mark.page > 0 && <small>{mark.page}</small>}
        </button>
      ))}
    </div>
  );
}

function NotesList({ book, annotations, reload, go }: { book: BookDetail; annotations: Annotation[]; reload: () => void; go: (block: number) => void }) {
  const [notes, reloadNotes] = useAsync(() => api.notes(book.id), [book.id]);
  const [open, setOpen] = useState<Note | null>(null);
  const items = annotations.filter((a) => a.kind === 'highlight').sort((a, b) => a.page - b.page || a.block - b.block);

  useEffect(reload, []);

  if (open) return <NoteSheet note={open} onBack={() => { setOpen(null); reloadNotes(); }} />;
  return (
    <div className="notes-list">
      <div className="notes-actions">
        <button className="ghost" onClick={() => void api.createNote({ book_id: book.id }).then(setOpen).catch(failure)}><Plus size={13} /> new</button>
        <a className="ghost" href={urls.notesMarkdown(book.id)} download><FileText size={13} /> export .md</a>
      </div>
      {notes?.map((note) => (
        <button key={note.id} className="note-row" onClick={() => setOpen(note)}>
          <strong>{note.title || 'untitled'}</strong>
          <span>{note.body.slice(0, 96)}</span>
        </button>
      ))}
      {items.map((item) => (
        <button key={item.id} className={`passage ${item.color}`} onClick={() => go(item.block)}>
          <blockquote>{item.quote}</blockquote>
          {item.note && <em>{item.note}</em>}
          {item.chapter && <small>{item.chapter}{item.page ? ` :: p.${item.page}` : ''}</small>}
        </button>
      ))}
      {!items.length && !notes?.length && <p className="hint">nothing marked yet.</p>}
    </div>
  );
}

export function NoteSheet({ note, onBack }: { note: Note; onBack: () => void }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const timer = useRef(0);
  const latest = useRef({ title, body });
  latest.current = { title, body };
  const schedule = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void api.updateNote(note.id, latest.current).catch(failure), 500);
  };
  const back = async () => {
    window.clearTimeout(timer.current);
    await api.updateNote(note.id, latest.current).catch(failure);
    onBack();
  };
  return (
    <div className="note-sheet">
      <div className="notes-actions">
        <button className="ghost" onClick={() => void back()}>:wq</button>
        <button className="icon" title="Delete note" onClick={() => {
          window.clearTimeout(timer.current);
          void api.deleteNote(note.id).then(onBack).catch(failure);
        }}><Trash2 size={14} /></button>
      </div>
      <input value={title} placeholder="title" onChange={(event) => { setTitle(event.target.value); schedule(); }} />
      <textarea value={body} placeholder="markdown works" onChange={(event) => { setBody(event.target.value); schedule(); }} />
    </div>
  );
}
