import { useSyncExternalStore } from 'react';
import { saveLocal, stored } from './preferences';

/** Day is sun on paper; night is steel. Auto follows the system setting. */
export type ThemeMode = 'auto' | 'day' | 'night';

const query = window.matchMedia('(prefers-color-scheme: dark)');
let mode: ThemeMode = stored<ThemeMode>('theme', 'auto');
const listeners = new Set<() => void>();
let snapshot = resolve();

function resolve() {
  return { mode, night: mode === 'night' || (mode === 'auto' && query.matches) };
}

function publish() {
  snapshot = resolve();
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  listeners.forEach((l) => l());
}

query.addEventListener('change', publish);

export function setTheme(next: ThemeMode) {
  mode = next;
  saveLocal('theme', next);
  publish();
}

/** Flips to the opposite of what is on screen now. */
export function toggleTheme() {
  setTheme(snapshot.night ? 'day' : 'night');
}

export function useTheme() {
  return useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => snapshot);
}
