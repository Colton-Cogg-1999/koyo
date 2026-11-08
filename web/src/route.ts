import { useSyncExternalStore } from 'react';

export type Route =
  | { view: 'library' }
  | { view: 'read'; id: string; block: number | null; page: number | null };

function parse(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const [head, id] = path.split('/');
  if (head === 'read' && id) {
    return { view: 'read', id, block: params.has('b') ? Number(params.get('b')) : null, page: params.has('p') ? Number(params.get('p')) || null : null };
  }
  return { view: 'library' };
}

let cached = { hash: '', route: parse('') };

function snapshot() {
  if (cached.hash !== location.hash) cached = { hash: location.hash, route: parse(location.hash) };
  return cached.route;
}

export function useRoute() {
  return useSyncExternalStore((listener) => {
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, snapshot);
}

export function navigate(path: string) {
  location.hash = `#/${path}`;
}
