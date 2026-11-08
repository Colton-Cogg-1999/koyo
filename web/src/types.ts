export interface TocEntry {
  idx: number;
  level: number;
  title: string;
  block: number;
  page: number;
  front: number;
}

export interface Chapter {
  idx: number;
  title: string;
  start: number;
  end: number;
  front: boolean;
}

export interface Section {
  idx: number;
  title: string;
  first_block: number;
  last_block: number;
}

export interface Position {
  block: number;
  fraction: number;
  page: number;
  progress: number;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  format: string;
  file_name: string;
  file_size: number;
  description: string;
  status: 'processing' | 'ready' | 'failed';
  error: string | null;
  has_cover: number;
  pages: number;
  words: number;
  chars: number;
  favorite: number;
  added_at: number;
  opened_at: number | null;
  progress: number;
  read_at: number | null;
  audio_status: string | null;
  annotation_count: number;
  collection_ids: string;
}

export interface BookDetail extends Book {
  toc: TocEntry[];
  sections: Section[];
  chapters: Chapter[];
  position: Position | null;
}

export interface TextAnchor {
  version?: 1;
  exact?: string;
  prefix?: string;
  suffix?: string;
  kind: 'text';
  startBlock: number;
  startOffset: number;
  endBlock: number;
  endOffset: number;
}

/** Each rectangle is `[page, x, y, width, height]`, normalized to the page. */
export interface PdfAnchor {
  kind: 'pdf';
  rects: [number, number, number, number, number][];
}

export interface BookmarkAnchor {
  kind: 'bookmark';
  block: number;
  page: number;
}

export type Anchor = TextAnchor | PdfAnchor | BookmarkAnchor;
export type Color = 'yellow' | 'blue' | 'green' | 'pink';

export interface Annotation {
  id: string;
  book_id: string;
  kind: 'highlight' | 'bookmark';
  color: Color;
  anchor: string;
  block: number;
  page: number;
  quote: string;
  note: string;
  created_at: number;
  updated_at: number;
  chapter?: string | null;
  book_title?: string;
  book_author?: string;
}

export interface Citation {
  n: number;
  block: number;
  page: number;
  chapter: string;
  quote: string;
}

export interface MessageContext { selection?: string; scope?: string; partial?: boolean; block?: number; chapter?: number; attachment?: { text: string; block: number; end_block: number } | null }

export interface Message {
  context?: MessageContext;
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  provider?: string;
  error?: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface Provider {
  id: 'claude' | 'codex';
  name: string;
  installed: boolean;
  signed_in: boolean;
  plan: string | null;
  models: { id: string; label: string }[];
  help: string;
}

export interface Providers {
  providers: Provider[];
  selected: string | null;
  model: string;
}

export interface SearchHit {
  book_id: string;
  block: number;
  page: number;
  title: string;
  snippet: string;
}

export interface BlockLocation {
  seq: number;
  section: number;
  page: number;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  kind: string;
}

export interface ReaderPrefs {
  font: 'serif' | 'mincho' | 'sans';
  size: number;
  leading: number;
  width: number;
  zoom: number;
}

export const defaultPrefs: ReaderPrefs = { font: 'serif', size: 21, leading: 1.62, width: 34, zoom: 1 };

/** Older saved preferences used other font names and a paper colour; keep what still applies. */
export function normalizePrefs(saved: unknown): ReaderPrefs {
  const raw = saved && typeof saved === 'object' ? saved as Partial<ReaderPrefs> : {};
  // Settings from the old interface (mono, Newsreader, paper colours) were tuned for a different
  // design; start those readers on the new defaults and keep only their PDF zoom.
  if (raw.font && !['serif', 'mincho', 'sans'].includes(raw.font)) return { ...defaultPrefs, zoom: Math.min(2.5, Math.max(0.6, Number(raw.zoom) || 1)) };
  const value = { ...defaultPrefs, ...raw };
  value.size = Math.min(32, Math.max(14, Number(value.size) || defaultPrefs.size));
  value.width = Math.min(48, Math.max(26, Number(value.width) || defaultPrefs.width));
  value.zoom = Math.min(2.5, Math.max(0.6, Number(value.zoom) || 1));
  return { font: value.font, size: value.size, leading: value.leading || defaultPrefs.leading, width: value.width, zoom: value.zoom };
}

/** Where the reader is: the block at the reading line, and the blocks on screen. */
export interface ReadingLocation {
  block: number;
  endBlock?: number;
  visibleStart?: number;
  fraction: number;
  page: number;
  ratio: number;
}
