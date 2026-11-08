import { useEffect, useState } from 'react';

const PREFIX = 'koyo:';

export function stored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(PREFIX + key) ?? 'null') ?? fallback; } catch { return fallback; }
}
export function saveLocal(key: string, value: unknown) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* Layout memory is optional; reading never depends on it. */ }
}
export function forget(key: string) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* nothing stored */ }
}
export function useLocalPreference<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => stored(key, fallback));
  useEffect(() => saveLocal(key, value), [key, value]);
  return [value, setValue] as const;
}
/** True when a keystroke belongs to a field rather than to a shortcut. */
export function editingTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('input,textarea,select,[contenteditable="true"]');
}
