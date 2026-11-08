import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../api';
import type { BookDetail, ReadingLocation, SearchHit } from '../types';
import { failure } from '../ui';
import { PanelHeader } from './Panel';

/** Table of contents and in-book search share one panel: both answer "where is it?". */
export function Contents({ book, location, go, searchNonce, onClose }: {
  book: BookDetail;
  location: ReadingLocation;
  go: (block: number, flash?: boolean, page?: number) => void;
  searchNonce: number;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const active = useRef<HTMLButtonElement>(null);
  const current = book.format === 'pdf'
    ? book.toc.findLastIndex((t) => t.page > 0 && t.page <= location.page)
    : book.toc.findLastIndex((t) => t.block <= location.block);

  useEffect(() => { if (searchNonce) field.current?.focus(); }, [searchNonce]);
  useEffect(() => { active.current?.scrollIntoView({ block: 'center' }); }, []);

  useEffect(() => {
    if (query.trim().length < 2) return setHits(null);
    let live = true;
    const timer = window.setTimeout(() => {
      api.search(query, book.id).then((list) => live && setHits(list)).catch(failure);
    }, 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [query, book.id]);

  return (
    <>
      <PanelHeader title="Contents" onClose={onClose} />
      <label className="panel-search">
        <Search size={15} />
        <input ref={field} type="search" aria-label="Search in this book" placeholder="Search in this book" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); }
            if (e.key === 'Enter' && hits?.[0]) go(hits[0].block, true);
          }} />
      </label>
      <div className="panel-scroll">
        {hits ? (
          <div className="hits">
            {hits.map((hit) => (
              <button key={hit.block} onClick={() => go(hit.block, true)}>
                <span>{snippet(hit.snippet)}</span>
                {hit.page > 0 && <small>p. {hit.page}</small>}
              </button>
            ))}
            {!hits.length && <p className="hint">No matches.</p>}
          </div>
        ) : (
          <nav className="toc" aria-label="Table of contents">
            {book.toc.map((entry, i) => (
              <button key={entry.idx} ref={i === current ? active : undefined} className={`level-${Math.min(entry.level, 3)} ${i === current ? 'current' : ''}`} aria-current={i === current ? 'location' : undefined} onClick={() => go(entry.block, false, entry.page)}>
                <span>{entry.title}</span>
                {entry.page > 0 && <small>{entry.page}</small>}
              </button>
            ))}
            {!book.toc.length && <p className="hint">This book has no table of contents.</p>}
          </nav>
        )}
      </div>
    </>
  );
}

/** Search marks matches with control characters, which become real elements here. */
function snippet(text: string) {
  return text.split(/\u0002|\u0003/).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}
