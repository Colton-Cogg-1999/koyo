import type {
  Annotation, Audiobook, AudiobookRow, BlockLocation, Book, BookDetail, ChatSummary, Citation, Collection, Message,
  Note, Providers, SearchHit, Storage, TrackDetail, TtsStatus,
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
  updateBook: (id: string, patch: { title?: string; author?: string; favorite?: boolean; collections?: number[] }) =>
    request(`/api/books/${id}`, send('PATCH', patch)),
  deleteBook: (id: string) => request(`/api/books/${id}`, send('DELETE')),
  section: (id: string, n: number) =>
    request<{ idx: number; title: string; html: string; first_block: number; last_block: number }>(`/api/books/${id}/sections/${n}`),
  block: (id: string, seq: number) => request<BlockLocation>(`/api/books/${id}/blocks/${seq}`),
  pageBlocks: (id: string, page: number) => request<BlockLocation[]>(`/api/books/${id}/pages/${page}/blocks`),
  savePosition: (id: string, block: number, fraction: number, page: number) =>
    request<{ progress: number }>(`/api/books/${id}/position`, { ...send('PUT', { block, fraction, page }), keepalive: true }),
  search: (q: string, book?: string) =>
    request<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}${book ? `&book=${book}` : ''}`),
  collections: () => request<Collection[]>('/api/collections'),
  createCollection: (name: string) => request<Collection>('/api/collections', send('POST', { name })),
  deleteCollection: (id: number) => request(`/api/collections/${id}`, send('DELETE')),
  settings: () => request<Record<string, unknown>>('/api/settings'),
  saveSettings: (values: Record<string, unknown>) => request('/api/settings', send('PUT', values)),
  storage: () => request<Storage>('/api/storage'),
  theme: () => request<{ name: string | null; colors: Record<string, string> }>('/api/theme'),
  openNotesFolder: () => request('/api/notes/open-folder', send('POST')),
  openExternal: (url: string) => request('/api/open', send('POST', { url })),

  annotations: (query: { book?: string; kind?: string } = {}) =>
    request<Annotation[]>(`/api/annotations?${new URLSearchParams(query as Record<string, string>)}`),
  createAnnotation: (body: Omit<Partial<Annotation>, 'anchor'> & { anchor: unknown }) => request<Annotation>('/api/annotations', send('POST', body)),
  updateAnnotation: (id: string, patch: { color?: string; note?: string }) => request<Annotation>(`/api/annotations/${id}`, send('PATCH', patch)),
  deleteAnnotation: (id: string) => request(`/api/annotations/${id}`, send('DELETE')),

  notes: (book?: string) => request<Note[]>(`/api/notes${book ? `?book=${book}` : ''}`),
  createNote: (body: { book_id?: string | null; title?: string; body?: string }) => request<Note>('/api/notes', send('POST', body)),
  updateNote: (id: string, patch: { title?: string; body?: string }) => request<Note>(`/api/notes/${id}`, {
    ...send('PATCH', patch),
    // Browsers cap keepalive payloads at 64 KiB; larger notebooks save normally.
    keepalive: new TextEncoder().encode(JSON.stringify(patch)).byteLength < 60_000,
  }),
  deleteNote: (id: string) => request(`/api/notes/${id}`, send('DELETE')),

  providers: (refresh = false) => request<Providers>(`/api/ai/providers${refresh ? '?refresh=1' : ''}`),
  chats: (book: string) => request<ChatSummary[]>(`/api/books/${book}/chats`),
  createChat: (book: string) => request<ChatSummary>(`/api/books/${book}/chats`, send('POST')),
  messages: (chat: string) => request<Message[]>(`/api/chats/${chat}/messages`),
  deleteChat: (chat: string) => request(`/api/chats/${chat}`, send('DELETE')),

  tts: () => request<TtsStatus>('/api/tts'),
  installTts: () => request('/api/tts/install', send('POST')),
  audiobooks: () => request<AudiobookRow[]>('/api/audiobooks'),
  audio: (book: string) => request<Audiobook>(`/api/books/${book}/audio`),
  startAudio: (book: string, voice: string, block?: number) => request<Audiobook>(`/api/books/${book}/audio`, send('POST', { voice, block })),
  pauseAudio: (book: string) => request<Audiobook>(`/api/books/${book}/audio/pause`, send('POST')),
  deleteAudio: (book: string) => request(`/api/books/${book}/audio`, send('DELETE')),
  exportAudio: (book: string) => request(`/api/books/${book}/audio/export`, send('POST')),
  saveListen: (book: string, seq: number, ms: number) => request(`/api/books/${book}/audio/position`, send('PUT', { seq, ms })),
  trackDetail: (book: string, seq: number) => request<TrackDetail>(`/api/books/${book}/audio/tracks/${seq}/detail`),
};

export const urls = {
  cover: (id: string) => `/api/books/${id}/cover`,
  file: (id: string) => `/api/books/${id}/file`,
  track: (book: string, seq: number) => `/api/books/${book}/audio/tracks/${seq}`,
  preview: (voice: string) => `/api/tts/preview/${voice}`,
  notesMarkdown: (book: string) => `/api/books/${book}/notes.md`,
  audioDownload: (book: string) => `/api/books/${book}/audio/download`,
};

export interface AskBody {
  question: string;
  label?: string;
  selection?: string;
  block?: number;
  scope?: 'chapter' | 'book';
}

export type AskEvent =
  | { type: 'citations'; citations: Citation[] }
  | { type: 'delta'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done'; id: number };

/** POST with a streamed response, which `EventSource` can't do. */
export async function ask(chat: string, body: AskBody, onEvent: (event: AskEvent) => void, signal: AbortSignal) {
  const response = await fetch(`/api/chats/${chat}/messages`, { ...send('POST', body), signal });
  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? 'Oma could not answer.');
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

/** One shared stream of server events for imports and audio progress. */
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
