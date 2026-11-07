import { useSyncExternalStore } from 'react';
import type { BookDetail } from './types';

export interface Location {
  block: number;
  fraction: number;
  page: number;
  ratio: number;
}

export interface Session {
  book: BookDetail | null;
  location: Location;
  go: (block: number, flash?: boolean) => void;
  seek: (ratio: number) => void;
  listenFrom: (block: number) => Promise<void>;
}

const idle: Session = {
  book: null,
  location: { block: 0, fraction: 0, page: 1, ratio: 0 },
  go: () => {},
  seek: () => {},
  listenFrom: async () => {},
};

let state = idle;
const listeners = new Set<() => void>();

/** The open book, shared with the panes that outlive any one view. */
export function publishSession(patch: Partial<Session>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function clearSession() {
  publishSession(idle);
}

export function useSession() {
  return useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => state);
}
