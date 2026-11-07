import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { api, onServerEvent } from './api';
import { AudioPane, NowPane, WORKSPACES } from './LeftPanes';
import { Reader } from './reader/Reader';
import { navigate, useRoute } from './route';
import type { Book, Collection, SearchHit } from './types';
import { failure, toast, Toasts, useAsync } from './ui';
import { AskBook, Library } from './views/Library';
import { Annotations, Audiobooks, Notebook, Settings } from './views/Others';

export function App() {
  const route = useRoute();
  const [books, reloadBooks] = useAsync<Book[]>(() => api.books(), []);
  const [collections, reloadCollections] = useAsync<Collection[]>(() => api.collections(), []);
  const [dragging, setDragging] = useState(false);
  const [focus, setFocus] = useState(false);
  const [search, setSearch] = useState<{ book?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  const refresh = useCallback(() => {
    reloadBooks();
    reloadCollections();
  }, []);

  useEffect(() => onServerEvent((event) => {
    if (event.type === 'book') {
      refresh();
      if (event.status === 'failed') toast('that file could not be opened; see the library', 'error');
    }
  }), [refresh]);

  const latest = books?.filter((b) => b.status === 'ready' && b.read_at).sort((a, b) => (b.read_at ?? 0) - (a.read_at ?? 0))[0];

  const goWorkspace = useCallback((path: string) => {
    if (path) navigate(path);
    else if (latest) navigate(`read/${latest.id}`);
  }, [latest]);

  useEffect(() => {
    const open = (event: Event) => setSearch({ book: (event as CustomEvent).detail?.book });
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,select') || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '/') {
        event.preventDefault();
        setSearch({ book: route.view === 'read' ? route.id : undefined });
      }
      const space = WORKSPACES.find((w) => w.key === event.key);
      if (space) goWorkspace(space.path);
    };
    window.addEventListener('oma-search', open);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('oma-search', open);
      window.removeEventListener('keydown', onKey);
    };
  }, [route, goWorkspace]);

  const importFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        const result = await api.upload(file);
        toast(result.duplicate ? `${file.name}: already in library` : `importing ${file.name}`);
        refresh();
      } catch (error) {
        failure(error);
      }
    }
  };

  return (
    <div
      className={`app ${focus ? 'zen' : ''}`}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        depth.current++;
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        if (--depth.current <= 0) {
          depth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        void importFiles(event.dataTransfer.files);
      }}
    >
      {!focus && (
        <aside className="left">
          <NowPane route={route} latest={latest} onWorkspace={goWorkspace} />
          <AudioPane />
        </aside>
      )}
      <main className="main">
        {route.view === 'library' && <Library books={books ?? []} collections={collections ?? []} filter={route} onChange={refresh} onImport={() => fileInput.current?.click()} />}
        {route.view === 'ask' && <AskBook key={route.id} id={route.id} />}
        {route.view === 'read' && <Reader key={route.id} id={route.id} startBlock={route.block} focus={focus} setFocus={setFocus} />}
        {route.view === 'annotations' && <Annotations />}
        {route.view === 'audiobooks' && <Audiobooks />}
        {route.view === 'notebook' && <Notebook />}
        {route.view === 'settings' && <Settings />}
      </main>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(event) => {
          if (event.target.files) void importFiles(event.target.files);
          event.target.value = '';
        }}
      />
      {dragging && (
        <div className="drop-veil">
          <strong>&gt;&gt;&gt; drop to import</strong>
          <span>epub pdf md docx html fb2 txt</span>
        </div>
      )}
      {search && <SearchSheet scope={search.book} onClose={() => setSearch(null)} />}
      <Toasts />
    </div>
  );
}

function SearchSheet({ scope, onClose }: { scope?: string; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [wide, setWide] = useState(!scope);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (query.trim().length < 2) return setHits([]);
      api.search(query, wide ? undefined : scope).then(setHits).catch(failure);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [query, wide, scope]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="search-veil" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="search-sheet">
        <header>
          <Search size={16} />
          <input autoFocus aria-label="Search" placeholder={wide ? 'grep all books' : 'grep this book'} value={query} onChange={(event) => setQuery(event.target.value)} />
          {scope && <button className="tab" onClick={() => setWide(!wide)}>{wide ? 'this book' : 'all books'}</button>}
          <button className="icon" title="Close" onClick={onClose}><X size={15} /></button>
        </header>
        <div className="hits">
          {hits.map((hit) => (
            <button key={`${hit.book_id}-${hit.block}`} onClick={() => { navigate(`read/${hit.book_id}?b=${hit.block}`); onClose(); }}>
              {wide && <small>{hit.title}</small>}
              <span>{snippet(hit.snippet)}</span>
              {hit.page > 0 && <em>p.{hit.page}</em>}
            </button>
          ))}
          {query.length > 1 && !hits.length && <p className="hint">no matches.</p>}
        </div>
      </div>
    </div>
  );
}

/** FTS marks matches with control characters, which become real elements here. */
function snippet(text: string) {
  return text.split(/\u0002|\u0003/).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}
