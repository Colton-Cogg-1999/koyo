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

export interface Note {
  id: string;
  book_id: string | null;
  book_title: string | null;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export interface Collection {
  id: number;
  name: string;
  count: number;
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

export interface Voice {
  id: string;
  name: string;
  accent: string;
  gender: string;
}

export interface TtsStatus {
  installed: boolean;
  voices: Voice[];
  default_voice: string;
  threads: number | null;
  cores: number;
  ffmpeg: boolean;
}

export interface Track {
  seq: number;
  chapter: number;
  first_block: number;
  last_block: number;
  chars: number;
  ready: number;
  duration_ms: number;
}

export interface Audiobook {
  status: 'none' | 'generating' | 'paused' | 'done' | 'failed';
  voice?: string;
  cursor?: number;
  error?: string | null;
  listen_seq?: number;
  listen_ms?: number;
  tracks?: Track[];
  has_export?: boolean;
  chars_per_second?: number;
}

/** `[block, startOffset, endOffset, startMs, endMs]` for each spoken sentence. */
export type Mark = [number, number, number, number, number];

export interface TrackDetail {
  seq: number;
  chapter: number;
  ready: number;
  duration_ms: number;
  marks: Mark[];
  peaks: number[];
}

export interface AudiobookRow {
  book_id: string;
  voice: string;
  status: string;
  error: string | null;
  title: string;
  author: string;
  has_cover: number;
  total: number;
  ready: number;
  duration_ms: number;
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

export interface Storage {
  data_dir: string;
  books_dir: string;
  notes_dir: string;
  books_bytes: number;
  audio_bytes: number;
  models_bytes: number;
  db_bytes: number;
  formats: string[];
  calibre_formats: string[];
  calibre_installed: boolean;
}

export interface ReaderPrefs {
  font: 'mono' | 'newsreader' | 'literata' | 'sans';
  size: number;
  leading: number;
  width: number;
  paper: 'term' | 'ivory' | 'sepia';
  zoom: number;
}

export const defaultPrefs: ReaderPrefs = { font: 'literata', size: 20, leading: 1.65, width: 36, paper: 'term', zoom: 1 };
