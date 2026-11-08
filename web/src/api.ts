import type {
  Annotation, BlockLocation, Book, BookDetail, ChatSummary, Citation, Message, MessageContext, Providers, SearchHit,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = response.statusText || 'Request failed';
    try {
      const body = await response.json();
      if (typeof body?.error === 'string') message = body.error;
    } catch { /* keep the status text */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

const send = (method: string, value?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: value === undefined ? undefined : JSON.stringify(value),
});

export const api = {
  books: () => request<Book[]>('/api/books'),
  book: (id: string) => request<BookDetail>(`/api/books/${id}`),
  upload: (file: File) =>
    request<{ id: string; duplicate: boolean }>('/api/books', {
      method: 'POST',
      headers: { 'x-file-name': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
      body: file,
    }),
  deleteBook: (id: string) => request(`/api/books/${id}`, send('DELETE')),
  section: (id: string, n: number) =>
    request<{ idx: number; title: string; html: string; first_block: number; last_block: number }>(`/api/books/${id}/sections/${n}`),
  block: (id: string, seq: number) => request<BlockLocation>(`/api/books/${id}/blocks/${seq}`),
  pageBlocks: (id: string, page: number) => request<BlockLocation[]>(`/api/books/${id}/pages/${page}/blocks`),
  savePosition: (id: string, block: number, fraction: number, page: number) =>
    request<{ progress: number }>(`/api/books/${id}/position`, { ...send('PUT', { block, fraction, page }), keepalive: true }),
  search: (q: string, book?: string) =>
    request<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}${book ? `&book=${book}` : ''}`),
  settings: () => request<Record<string, unknown>>('/api/settings'),
  saveSettings: (values: Record<string, unknown>) => request('/api/settings', send('PUT', values)),
  openExternal: (url: string) => request('/api/open', send('POST', { url })),

  annotations: (query: { book?: string; kind?: string } = {}) =>
    request<Annotation[]>(`/api/annotations?${new URLSearchParams(query as Record<string, string>)}`),
  createAnnotation: (body: Omit<Partial<Annotation>, 'anchor'> & { anchor: unknown }) => request<Annotation>('/api/annotations', send('POST', body)),
  updateAnnotation: (id: string, patch: { color?: string; note?: string }) => request<Annotation>(`/api/annotations/${id}`, send('PATCH', patch)),
  deleteAnnotation: (id: string) => request(`/api/annotations/${id}`, send('DELETE')),

  providers: (refresh = false) => request<Providers>(`/api/ai/providers${refresh ? '?refresh=1' : ''}`),
  chats: (book: string) => request<ChatSummary[]>(`/api/books/${book}/chats`),
  createChat: (book: string) => request<ChatSummary>(`/api/books/${book}/chats`, send('POST')),
  messages: (chat: string) => request<Message[]>(`/api/chats/${chat}/messages`),
};

export const urls = {
  cover: (id: string) => `/api/books/${id}/cover`,
  file: (id: string) => `/api/books/${id}/file`,
  notesMarkdown: (book: string) => `/api/books/${book}/notes.md`,
};

export interface AskBody {
  question: string;
  label?: string;
  selection?: string;
  attachment?: { text: string; block: number; end_block: number };
  block?: number;
  scope?: 'page' | 'selection' | 'chapter' | 'book' | 'search';
  end_block?: number;
  page?: number;
  chapter?: number;
}

export type AskEvent =
  | { type: 'context'; context: MessageContext }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'delta'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; id: number };

/** POST with a streamed response, which `EventSource` can't do. */
export async function ask(chat: string, body: AskBody, onEvent: (event: AskEvent) => void, signal: AbortSignal) {
  const response = await fetch(`/api/chats/${chat}/messages`, { ...send('POST', body), signal });
  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? 'No answer came back.');
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (data) onEvent(JSON.parse(data) as AskEvent);
      boundary = buffer.indexOf('\n\n');
    }
  }
}

type Listener = (event: Record<string, any>) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

/** One shared stream of server events, used for import progress. */
export function onServerEvent(listener: Listener) {
  if (!source) {
    source = new EventSource('/api/events');
    source.onmessage = (message) => {
      const value = JSON.parse(message.data);
      listeners.forEach((l) => l(value));
    };
  }
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
