import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Moon, SunMedium } from 'lucide-react';
import { urls } from './api';
import { navigate } from './route';
import { toggleTheme, useTheme } from './theme';
import type { Book } from './types';

/** The product name lives here alone, so a rename is one line. */
export const NAME = 'Kōyō';

/** The mark is the rising sun and nothing else: a red disc. */
export function Mark({ size = 24 }: { size?: number }) {
  return <i className="mark" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function Brand() {
  return (
    <button className="brand" onClick={() => navigate('library')} title="Library">
      <Mark />
      <span className="brand-word">{NAME}</span>
    </button>
  );
}

/** A small filled disc that marks anything the AI says or does. */
export function Sun({ size = 10 }: { size?: number }) {
  return <i className="sun" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function TopBar({ children }: { children: ReactNode }) {
  return <header className="topbar">{children}</header>;
}

export function ThemeToggle() {
  const { night } = useTheme();
  return (
    <button className="icon" title={night ? 'Day (d)' : 'Night (d)'} aria-label={night ? 'Switch to day' : 'Switch to night'} onClick={toggleTheme}>
      {night ? <SunMedium size={17} /> : <Moon size={16} />}
    </button>
  );
}

const TONES = ['#8e2f38', '#a9512d', '#9c7a35', '#5f6b3e', '#344360', '#5d3a52', '#46403b', '#6e5844'];

export function Cover({ book, className = '' }: { book: Pick<Book, 'id' | 'title' | 'author' | 'has_cover'>; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (book.has_cover && !failed) {
    return <img className={`cover ${className}`} src={urls.cover(book.id)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  }
  // Books without a cover are bound like a Japanese wahon: dyed paper in an autumn tone,
  // a stitched spine, and a cream title slip.
  const tone = TONES[[...book.title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TONES.length];
  return (
    <div className={`cover cover-made ${className}`} style={{ '--tone': tone } as React.CSSProperties}>
      <span className="slip">
        <strong>{book.title}</strong>
        {book.author && <small>{book.author}</small>}
      </span>
    </div>
  );
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
  }, tone === 'error' ? 8000 : 3200);
}

export function failure(error: unknown) {
  toast(error instanceof Error ? error.message : String(error), 'error');
}

export function Toasts() {
  const items = useSyncExternalStore((l) => (toastListeners.add(l), () => void toastListeners.delete(l)), () => toasts);
  return (
    <div className="toasts" role="status">
      {items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
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

/** Closes a popover on an outside press or Escape. */
export function useDismiss(open: boolean, close: () => void, inside: () => (Element | null)[]) {
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (!inside().some((el) => el?.contains(event.target as Node))) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
    };
    document.addEventListener('pointerdown', press);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', press);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
}
