import { useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, Plus, Search } from 'lucide-react';
import { api, urls } from './api';
import { editingTarget } from './preferences';
import { navigate } from './route';
import type { Book } from './types';
import { Brand, Cover, failure, Mark, ThemeToggle, toast, TopBar, useDismiss } from './ui';

export function Library({ books, onImport, onChange, formats }: {
  books: Book[] | null;
  onImport: () => void;
  onChange: () => void;
  formats: string;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '/') { event.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ordered = useMemo(() => [...(books ?? [])].sort((a, b) => (b.read_at ?? b.added_at) - (a.read_at ?? a.added_at)), [books]);
  const needle = query.trim().toLowerCase();
  const shown = needle ? ordered.filter((b) => `${b.title} ${b.author}`.toLowerCase().includes(needle)) : ordered;
  const current = !needle ? ordered.find((b) => b.status === 'ready' && b.read_at && b.progress < 0.995) : undefined;

  return (
    <div className="library">
      <TopBar>
        <Brand />
        <span className="grow" />
        {!!books?.length && (
          <label className="filter">
            <Search size={15} />
            <input ref={search} type="search" aria-label="Find a book" placeholder="Find a book" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), e.currentTarget.blur())} />
          </label>
        )}
        <button className="ghost add" onClick={onImport} aria-label="Add books"><Plus size={15} /><span className="label">Add books</span></button>
        <ThemeToggle />
      </TopBar>

      <main className="shelf">
        {books && books.length === 0 && (
          <section className="welcome">
            <Mark size={120} />
            <h1>A quiet room for reading.</h1>
            <p>Bring your own books. Highlight what matters, keep notes beside the text, and ask questions of the page when you need to.</p>
            <button className="solid" onClick={onImport}>Add your first book</button>
            <small>or drop files anywhere · {formats}</small>
          </section>
        )}

        {current && (
          <section className="continue">
            <button className="continue-cover" onClick={() => navigate(`read/${current.id}`)} aria-label={`Continue ${current.title}`}>
              <Cover book={current} />
            </button>
            <div className="continue-text">
              <span className="eyebrow">Continue reading</span>
              <h1>{current.title}</h1>
              {current.author && <p className="byline">{current.author}</p>}
              <div className="meter" aria-label={`${Math.round(current.progress * 100)} percent read`}><i style={{ width: `${current.progress * 100}%` }} /></div>
              <p className="meta">{Math.round(current.progress * 100)}% · {current.annotation_count} {current.annotation_count === 1 ? 'note' : 'notes'}</p>
              <button className="solid" onClick={() => navigate(`read/${current.id}`)}>Continue</button>
            </div>
            <span className="kanji" aria-hidden="true">紅葉</span>
          </section>
        )}

        {!!books?.length && (
          <section>
            <h2 className="eyebrow">{needle ? `${shown.length} found` : `Shelf · ${books.length}`}</h2>
            <div className="grid" role="list">
              {shown.map((book) => <Card key={book.id} book={book} onChange={onChange} />)}
            </div>
            {!shown.length && <p className="hint">Nothing on the shelf matches “{query}”.</p>}
          </section>
        )}
      </main>
    </div>
  );
}

function Card({ book, onChange }: { book: Book; onChange: () => void }) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(menu, () => setMenu(false), () => [box.current]);
  const ready = book.status === 'ready';
  const remove = () => {
    setMenu(false);
    if (!window.confirm(`Remove “${book.title}” and its notes from the shelf?`)) return;
    void api.deleteBook(book.id).then(() => { toast('Removed'); onChange(); }).catch(failure);
  };
  return (
    <article className={`card ${book.status}`} role="listitem" title={book.title}>
      <button className="card-open" disabled={!ready} onClick={() => navigate(`read/${book.id}`)}>
        <Cover book={book} />
        {book.status === 'processing' && <span className="card-state">Preparing…</span>}
        <span className="card-title">{book.title}</span>
        <span className="card-author">{book.author || book.format.toUpperCase()}</span>
        {book.progress > 0 && <span className="meter thin"><i style={{ width: `${book.progress * 100}%` }} /></span>}
      </button>
      {book.status === 'failed' && <p className="error">{book.error}</p>}
      <div className="card-menu" ref={box}>
        <button className="icon" aria-label={`Options for ${book.title}`} aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={16} /></button>
        {menu && (
          <div className="popover menu" role="menu">
            {ready && <a role="menuitem" href={urls.file(book.id)} download={book.file_name} onClick={() => setMenu(false)}>Download original</a>}
            {ready && book.annotation_count > 0 && <a role="menuitem" href={urls.notesMarkdown(book.id)} download onClick={() => setMenu(false)}>Export notes (.md)</a>}
            <button role="menuitem" className="danger" onClick={remove}>Remove from shelf</button>
          </div>
        )}
      </div>
    </article>
  );
}
