import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { navigate } from '../route';
import type { Book, Collection } from '../types';
import { bytes, Cover, Empty, failure, Gauge, Pane, toast, when } from '../ui';

/** A file manager for books: a keyboard list on the left, a preview on the right. */
export function Library({ books, collections, filter, onChange, onImport }: {
  books: Book[];
  collections: Collection[];
  filter: { collection?: string; favorites?: boolean };
  onChange: () => void;
  onImport: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return books.filter((book) => {
      if (filter.favorites && !book.favorite) return false;
      if (filter.collection && !book.collection_ids.split(',').includes(filter.collection)) return false;
      return !needle || `${book.title} ${book.author}`.toLowerCase().includes(needle);
    });
  }, [books, filter, query]);
  const selected = shown[Math.min(cursor, shown.length - 1)];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,select') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((c) => Math.min(shown.length - 1, c + 1));
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (event.key === 'Enter' && selected?.status === 'ready') {
        navigate(`read/${selected.id}`);
      } else if (event.key === 'a') {
        onImport();
      } else if (event.key === 's' && selected) {
        void api.updateBook(selected.id, { favorite: !selected.favorite }).then(onChange).catch(failure);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, selected, onChange, onImport]);

  const tabs = (
    <>
      <button className={`tab ${!filter.collection && !filter.favorites ? 'on' : ''}`} onClick={() => navigate('library')}>all</button>
      <button className={`tab ${filter.favorites ? 'on' : ''}`} onClick={() => navigate('library?fav')}>starred</button>
      {collections.map((collection) => (
        <button key={collection.id} className={`tab ${filter.collection === String(collection.id) ? 'on' : ''}`} onClick={() => navigate(`library?c=${collection.id}`)}>{collection.name}</button>
      ))}
    </>
  );

  return (
    <div className="split">
      <Pane title={<>LIBRARY <i>// {shown.length} {shown.length === 1 ? 'book' : 'books'}</i></>} tools={tabs} className="shelf">
        <div className="shelf-tools">
          <input type="search" aria-label="Filter" placeholder="filter" value={query} onChange={(event) => { setQuery(event.target.value); setCursor(0); }} />
          <button className="solid" onClick={onImport}>+ add [a]</button>
        </div>
        {shown.length === 0 ? (
          <Empty title={books.length ? 'no matches' : 'library empty'}>
            {books.length ? 'nothing in this view.' : 'drop an EPUB, PDF, or any document anywhere in this window, or press a.'}
          </Empty>
        ) : (
          <div className="rows" role="listbox" aria-label="Books">
            {shown.map((book, i) => (
              <button
                key={book.id}
                role="option"
                aria-selected={book === selected}
                className={`row ${book === selected ? 'on' : ''} ${book.status}`}
                title={book.title}
                onClick={() => setCursor(i)}
                onDoubleClick={() => book.status === 'ready' && navigate(`read/${book.id}`)}
              >
                <b>{book === selected ? '>' : ' '}</b>
                <span className="row-title">{book.title}</span>
                <span className="row-author">{book.author}</span>
                <span className="row-format">{book.format}</span>
                <Gauge value={book.progress} />
                <span className="row-flags">{book.favorite ? '*' : ' '}{book.audio_status ? 'a' : ' '}{book.annotation_count ? 'n' : ' '}</span>
              </button>
            ))}
          </div>
        )}
        <footer className="keys"><kbd>j</kbd><kbd>k</kbd> move <kbd>enter</kbd> open <kbd>s</kbd> star <kbd>a</kbd> add <kbd>/</kbd> search text</footer>
      </Pane>
      {selected ? <Preview key={selected.id} book={selected} collections={collections} onChange={onChange} /> : <Pane title="PREVIEW" className="preview"><p className="hint">no selection.</p></Pane>}
    </div>
  );
}

function Preview({ book, collections, onChange }: { book: Book; collections: Collection[]; onChange: () => void }) {
  const [newName, setNewName] = useState('');
  const memberOf = book.collection_ids ? book.collection_ids.split(',').map(Number) : [];
  const update = (patch: Parameters<typeof api.updateBook>[1]) => api.updateBook(book.id, patch).then(onChange).catch(failure);
  const toggle = (id: number) => update({ collections: memberOf.includes(id) ? memberOf.filter((c) => c !== id) : [...memberOf, id] });
  return (
    <Pane title="PREVIEW" className="preview">
      <div className="preview-body">
        <Cover book={book} />
        <h3>{book.title}</h3>
        {book.author && <p className="preview-author">{book.author}</p>}
        {book.status === 'failed' && <p className="error">ERR&gt; {book.error}</p>}
        {book.status === 'processing' && <p className="hint">indexing…</p>}
        <dl>
          <dt>type</dt><dd>{book.format}</dd>
          <dt>size</dt><dd>{bytes(book.file_size)}</dd>
          <dt>pages</dt><dd>{book.pages}</dd>
          <dt>words</dt><dd>{book.words.toLocaleString()}</dd>
          <dt>added</dt><dd>{when(book.added_at)}</dd>
          <dt>read</dt><dd>{Math.round(book.progress * 100)}%</dd>
          <dt>marks</dt><dd>{book.annotation_count}</dd>
        </dl>
        {book.description && <p className="preview-text">{book.description.slice(0, 280)}</p>}
        <div className="preview-actions">
          <button className="solid" disabled={book.status !== 'ready'} onClick={() => navigate(`read/${book.id}`)}>open</button>
          <button className="ghost" onClick={() => void update({ favorite: !book.favorite })}>{book.favorite ? 'unstar' : 'star'}</button>
          <button className="ghost danger" onClick={() => {
            if (!window.confirm(`Remove "${book.title}" with its notes and audio?`)) return;
            void api.deleteBook(book.id).then(() => { toast('removed'); onChange(); }).catch(failure);
          }}>remove</button>
        </div>
        <h4>COLLECTIONS</h4>
        <div className="preview-collections">
          {collections.map((collection) => (
            <button key={collection.id} className={memberOf.includes(collection.id) ? 'on' : ''} onClick={() => void toggle(collection.id)}>[{memberOf.includes(collection.id) ? 'x' : ' '}] {collection.name}</button>
          ))}
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!newName.trim()) return;
            void api.createCollection(newName).then((created) => {
              setNewName('');
              return update({ collections: [...memberOf, created.id] });
            }).catch(failure);
          }}>
            <input aria-label="New collection" placeholder="new collection" value={newName} onChange={(event) => setNewName(event.target.value)} />
          </form>
        </div>
      </div>
    </Pane>
  );
}
