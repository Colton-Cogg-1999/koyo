import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onServerEvent } from './api';
import { Library } from './Library';
import { editingTarget } from './preferences';
import { Reader } from './reader/Reader';
import { useRoute } from './route';
import { toggleTheme } from './theme';
import type { Book } from './types';
import { failure, Mark, toast, Toasts, useAsync } from './ui';

const FORMATS = 'epub · pdf · md · html · docx · fb2 · txt';

/** Two places only: the shelf and the page. */
export function App() {
  const route = useRoute();
  const [books, reloadBooks] = useAsync<Book[]>(() => api.books(), []);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  useEffect(() => onServerEvent((event) => {
    if (event.type !== 'book') return;
    reloadBooks();
    if (event.status === 'failed') toast('That file could not be opened. Details are on its card.', 'error');
  }), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (editingTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'd') toggleTheme();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const importFiles = useCallback(async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        const result = await api.upload(file);
        toast(result.duplicate ? `${file.name} is already on the shelf` : `Adding ${file.name}`);
        reloadBooks();
      } catch (error) {
        failure(error);
      }
    }
  }, []);

  const openPicker = useCallback(() => fileInput.current?.click(), []);

  return (
    <div
      className="app"
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
      {route.view === 'read'
        ? <Reader key={route.id} id={route.id} startBlock={route.block} startPage={route.page} />
        : <Library books={books} onImport={openPicker} onChange={reloadBooks} formats={FORMATS} />}
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
          <Mark size={88} />
          <strong>Drop to add to your shelf</strong>
          <span>{FORMATS}</span>
        </div>
      )}
      <Toasts />
    </div>
  );
}
