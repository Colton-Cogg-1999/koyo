import { useEffect, useRef, useState } from 'react';
import { FileText, Plus, Trash2 } from 'lucide-react';
import { api, urls } from '../api';
import type { Annotation, BookDetail, Note } from '../types';
import { failure, Pane, useAsync } from '../ui';
import type { NotePositions } from './ReflowView';

export type MarginTab = 'margin' | 'index' | 'notebook';

export function Margin({ book, annotations, block, bookmarks, tab, setTab, go, reload, onEdit }: {
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
    <Pane title="Notes" tools={tools} className="margin-pane">
      {tab === 'margin' && <Refs book={book} annotations={annotations} block={block} go={go} onEdit={onEdit} />}
      {tab === 'index' && <Index book={book} block={block} bookmarks={bookmarks} go={go} />}
      {tab === 'notebook' && <NotesList book={book} annotations={annotations} reload={reload} go={go} />}
    </Pane>
  );
}

/** Chapter context is a stable location-ordered view of the shared annotation records. */
function Refs({ book, annotations, block, go, onEdit }: {
  book: BookDetail; annotations: Annotation[]; block: number;
  go: (block: number, flash?: boolean) => void;
  onEdit: (annotation: Annotation, rect: DOMRect) => void;
}) {
  const chapter = book.chapters.findLast((c) => c.start <= block);
  const items = annotations.filter((a) => !chapter || a.block >= chapter.start && a.block < chapter.end).sort((a,b) => a.block - b.block || a.created_at - b.created_at);
  const nearest = items.reduce<Annotation | null>((best,a) => !best || Math.abs(a.block-block) < Math.abs(best.block-block) ? a : best, null);
  return <div className="chapter-notes">
    {items.map((note) => <div className={`chapter-note ${note.id === nearest?.id ? 'near' : ''}`} key={note.id}>
      <button className="ref" onClick={() => go(note.block)}>
        <small>{note.page ? `p. ${note.page}` : `Location ${note.block + 1}`}{note.kind === 'bookmark' ? ' · Bookmark' : note.note ? ' · Note' : ' · Highlight'}</small>
        <span>{note.note || note.quote || 'Bookmark'}</span>
      </button>
      <button className="icon mark-edit" title="Edit annotation" aria-label="Edit annotation" onClick={(e) => onEdit(note,e.currentTarget.getBoundingClientRect())}>…</button>
    </div>)}
    {!items.length && <p className="hint">No notes in this chapter.</p>}
  </div>;
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
  const draftKey = `omareader-note-draft:${note.id}`;
  const [initial] = useState(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
      if (typeof draft?.title === 'string' && typeof draft?.body === 'string') return { ...draft, recovered: true };
    } catch { /* A disabled browser store must not prevent editing. */ }
    return { title: note.title, body: note.body, recovered: false };
  });
  const [title, setTitle] = useState<string>(initial.title);
  const [body, setBody] = useState<string>(initial.body);
  const [status, setStatus] = useState(initial.recovered ? 'recovered unsaved draft' : 'saved');
  const timer = useRef(0);
  const latest = useRef({ title: initial.title as string, body: initial.body as string });
  const dirty = useRef(!!initial.recovered);
  const deleted = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = () => {
    window.clearTimeout(timer.current);
    if (!dirty.current || deleted.current) return queue.current;
    const snapshot = latest.current;
    setStatus('saving…');
    const pending = queue.current.catch(() => {}).then(() => api.updateNote(note.id, snapshot));
    queue.current = pending;
    return pending.then(() => {
      if (latest.current === snapshot) {
        dirty.current = false; setStatus('saved');
        try { localStorage.removeItem(draftKey); } catch { /* The server copy is saved. */ }
      }
    }).catch((error) => { setStatus('save failed — your edits are still here'); throw error; });
  };
  const change = (next: { title: string; body: string }) => {
    latest.current = next;
    dirty.current = true;
    try { localStorage.setItem(draftKey, JSON.stringify(next)); } catch {
      failure(new Error('Browser draft storage is unavailable. Keep this note open until it is saved.'));
    }
    setTitle(next.title); setBody(next.body); setStatus('unsaved');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save().catch(failure), 500);
  };
  useEffect(() => {
    const flush = () => { if (dirty.current && !deleted.current) void save().catch(failure); };
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current && !deleted.current) { flush(); event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', warn);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', warn);
      flush();
    };
  }, [note.id]);
  const back = async () => {
    try { await save(); onBack(); } catch (error) { failure(error); }
  };
  return (
    <div className="note-sheet">
      <div className="notes-actions">
        <button className="ghost" onClick={() => void back()}>save & back</button>
        <span className="hint" role="status">{status}</span>
        <button className="icon" title="Delete note" onClick={() => {
          if (!window.confirm('Delete this note?')) return;
          window.clearTimeout(timer.current);
          deleted.current = true;
          void queue.current.catch(() => {}).then(() => api.deleteNote(note.id)).then(() => {
            try { localStorage.removeItem(draftKey); } catch { /* The note was deleted. */ }
            onBack();
          }).catch((error) => {
            deleted.current = false; failure(error);
          });
        }}><Trash2 size={14} /></button>
      </div>
      <input aria-label="Note title" value={title} placeholder="title" onChange={(event) => change({ ...latest.current, title: event.target.value })} />
      <textarea aria-label="Note body" value={body} placeholder="markdown works" onChange={(event) => change({ ...latest.current, body: event.target.value })} />
    </div>
  );
}
