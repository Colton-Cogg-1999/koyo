import { useEffect, useState } from 'react';

export function stored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(`omareader:${key}`) ?? 'null') ?? fallback; } catch { return fallback; }
}
export function saveLocal(key: string, value: unknown) {
  try { localStorage.setItem(`omareader:${key}`, JSON.stringify(value)); } catch { /* Optional layout storage must not block reading. */ }
}
export function useLocalPreference<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => stored(key, fallback));
  useEffect(() => saveLocal(key, value), [key, value]);
  return [value, setValue] as const;
}
export function editingTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]');
}
export function readerCommand(command: string) {
  window.dispatchEvent(new CustomEvent('oma-reader-command', { detail: command }));
}
