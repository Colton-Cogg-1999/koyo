import { useSyncExternalStore } from 'react';

export type Route =
  | { view: 'library'; collection?: string; favorites?: boolean }
  | { view: 'read'; id: string; block: number | null; page: number | null }
  | { view: 'ask'; id: string }
  | { view: 'annotations' }
  | { view: 'audiobooks' }
  | { view: 'notebook' }
  | { view: 'settings' };

function parse(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(query);
  const [head, id] = path.split('/');
  switch (head) {
    case 'ask':
      return { view: 'ask', id };
    case 'read':
      return { view: 'read', id, block: params.has('b') ? Number(params.get('b')) : null, page: params.has('p') ? Number(params.get('p')) : null };
    case 'annotations':
    case 'audiobooks':
    case 'notebook':
    case 'settings':
      return { view: head };
    default:
      return { view: 'library', collection: params.get('c') ?? undefined, favorites: params.has('fav') };
  }
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
