import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { urls } from './api';
import type { Book } from './types';

export function Logo({ height = 26 }: { height?: number }) {
  return <span className="logo" role="img" aria-label="Omarchy" style={{ height, width: height * 4.263 }} />;
}

export function Pane({ title, tools, className = '', children }: { title?: ReactNode; tools?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`pane ${className}`}>
      {title !== undefined && (
        <header className="pane-title">
          <h2>{title}</h2>
          {tools && <div className="pane-tools">{tools}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Gauge({ value }: { value: number }) {
  return <span className="gauge" aria-hidden="true"><b style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></span>;
}

export function Cover({ book, className = '' }: { book: Pick<Book, 'id' | 'title' | 'has_cover'>; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (book.has_cover && !failed) {
    return <img className={`cover ${className}`} src={urls.cover(book.id)} alt="" loading="lazy" onError={() => setFailed(true)} />;
  }
  return <div className={`cover cover-made ${className}`}><span>{book.title}</span></div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Logo height={46} />
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}

export function clock(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

export function bytes(value: number) {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function when(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

let toasts: Toast[] = [];
let nextToast = 1;
const toastListeners = new Set<() => void>();

export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = nextToast++;
  toasts = [...toasts, { id, text, tone }];
  toastListeners.forEach((l) => l());
  window.setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    toastListeners.forEach((l) => l());
  }, tone === 'error' ? 9000 : 3500);
}

export function failure(error: unknown) {
  toast(error instanceof Error ? error.message : String(error), 'error');
}

export function Toasts() {
  const items = useSyncExternalStore((l) => (toastListeners.add(l), () => void toastListeners.delete(l)), () => toasts);
  return (
    <div className="toasts" role="status">
      {items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.tone === 'error' ? 'ERR> ' : '>>> '}{t.text}</div>)}
    </div>
  );
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [value, setValue] = useState<T | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    load().then((v) => live && setValue(v)).catch(failure);
    return () => {
      live = false;
    };
  }, [...deps, version]);
  return [value, () => setVersion((v) => v + 1), setValue] as const;
}
