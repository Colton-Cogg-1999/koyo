import { useSyncExternalStore } from 'react';
import { api, onServerEvent, urls } from './api';
import type { Mark, Track, TrackDetail } from './types';

export interface PlayerState {
  book: string | null;
  title: string;
  tracks: Track[];
  seq: number;
  ms: number;
  playing: boolean;
  /** Waiting for a track that is still being generated. */
  waiting: boolean;
  rate: number;
  mark: { block: number; start: number; end: number } | null;
  peaks: number[];
}

const initial: PlayerState = {
  book: null, title: '', tracks: [], seq: 0, ms: 0, playing: false, waiting: false, rate: 1, mark: null, peaks: [],
};

/** Words per minute at 1× is close to this, and it's only used for tracks not generated yet. */
const CHARS_PER_MS = 0.0155;

class Player {
  private audio = new Audio();
  private state = initial;
  private listeners = new Set<() => void>();
  private details = new Map<number, TrackDetail>();
  private pendingSeek: { seq: number; ms?: number; block?: number } | null = null;
  private saveTimer = 0;

  constructor() {
    this.audio.preload = 'auto';
    this.audio.addEventListener('timeupdate', () => this.tick());
    this.audio.addEventListener('ended', () => this.advance());
    this.audio.addEventListener('pause', () => this.set({ playing: false }));
    this.audio.addEventListener('play', () => this.set({ playing: true, waiting: false }));
    onServerEvent((event) => {
      if (event.type === 'audio' && event.book_id === this.state.book) void this.refresh();
    });
  }

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  snapshot = () => this.state;

  private detail(seq: number) {
    const cached = this.details.get(seq);
    if (cached) return Promise.resolve(cached);
    return api.trackDetail(this.state.book!, seq).then((d) => {
      if (d.ready) this.details.set(seq, d);
      return d;
    });
  }

  /** Attaches a book without starting playback, restoring the saved listening spot. */
  async load(book: string, title: string) {
    if (this.state.book === book) {
      await this.refresh();
      return;
    }
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.details.clear();
    const summary = await api.audio(book);
    this.set({ ...initial, rate: this.state.rate, book, title, tracks: summary.tracks ?? [], seq: summary.listen_seq ?? 0, ms: summary.listen_ms ?? 0 });
    const current = (summary.tracks ?? [])[summary.listen_seq ?? 0];
    if (current?.ready) {
      const detail = await this.detail(current.seq);
      this.set({ peaks: detail.peaks });
    }
  }

  async refresh() {
    if (!this.state.book) return;
    const summary = await api.audio(this.state.book);
    this.set({ tracks: summary.tracks ?? [] });
    if (!summary.tracks?.length) {
      this.audio.pause();
      this.set({ playing: false, waiting: false, mark: null });
      return;
    }
    const pending = this.pendingSeek;
    if (this.state.waiting && pending) {
      const track = this.state.tracks[pending.seq];
      if (track?.ready) await this.start(pending.seq, pending.ms, pending.block);
    }
  }

  private async start(seq: number, ms = 0, block?: number) {
    const track = this.state.tracks[seq];
    if (!track) return;
    if (!track.ready) {
      this.pendingSeek = { seq, ms, block };
      this.audio.pause();
      this.set({ seq, ms: 0, waiting: true, mark: null });
      return;
    }
    this.pendingSeek = null;
    const detail = await this.detail(seq);
    let target = ms;
    if (block !== undefined) {
      const mark = detail.marks.find((m) => m[0] >= block);
      if (mark) target = mark[3];
    }
    const src = urls.track(this.state.book!, seq);
    if (!this.audio.src.endsWith(src)) {
      this.audio.src = src;
      this.audio.playbackRate = this.state.rate;
    }
    this.set({ seq, ms: target, peaks: detail.peaks, waiting: false });
    const begin = () => {
      this.audio.currentTime = target / 1000;
      void this.audio.play().catch(() => this.set({ playing: false }));
    };
    if (this.audio.readyState >= 1) begin();
    else this.audio.addEventListener('loadedmetadata', begin, { once: true });
  }

  play(seq?: number, ms?: number) {
    return this.start(seq ?? this.state.seq, ms ?? this.state.ms);
  }

  toggle() {
    if (this.state.playing) {
      this.audio.pause();
      this.persist();
    } else if (this.state.waiting) {
      this.pendingSeek = null;
      this.set({ waiting: false });
    } else {
      void this.play();
    }
  }

  /** Moves the playhead without starting playback. */
  cue(seq: number) {
    if (this.state.playing) return;
    this.set({ seq, ms: 0 });
  }

  /** Begins narration at a block, waiting for that track if it isn't ready. */
  async playBlock(block: number) {
    const track = this.state.tracks.find((t) => t.last_block >= block);
    if (track) await this.start(track.seq, 0, block);
  }

  private advance() {
    const next = this.state.seq + 1;
    if (next < this.state.tracks.length) void this.start(next);
    else this.set({ playing: false, mark: null });
  }

  chapterTracks() {
    const current = this.state.tracks[this.state.seq];
    return current ? this.state.tracks.filter((t) => t.chapter === current.chapter) : [];
  }

  private duration(track: Track) {
    return track.ready ? track.duration_ms : track.chars / CHARS_PER_MS;
  }

  chapterTiming() {
    const tracks = this.chapterTracks();
    let elapsed = 0;
    let total = 0;
    for (const track of tracks) {
      if (track.seq < this.state.seq) elapsed += this.duration(track);
      total += this.duration(track);
    }
    return { elapsed: elapsed + this.state.ms, total };
  }

  /** Seeks within the chapter, crossing tracks as needed. */
  seekChapter(ms: number) {
    let left = ms;
    const tracks = this.chapterTracks();
    for (const track of tracks) {
      const length = this.duration(track);
      if (left <= length || track === tracks[tracks.length - 1]) {
        void this.start(track.seq, Math.min(left, length));
        return;
      }
      left -= length;
    }
  }

  seekChapterStart() {
    const first = this.chapterTracks()[0];
    if (first) this.set({ seq: first.seq, ms: 0, mark: null });
    this.audio.removeAttribute('src');
  }

  skip(seconds: number) {
    const { elapsed, total } = this.chapterTiming();
    this.seekChapter(Math.max(0, Math.min(total, elapsed + seconds * 1000)));
  }

  stepChapter(direction: 1 | -1) {
    const current = this.state.tracks[this.state.seq];
    if (!current) return;
    if (direction === -1) {
      const start = this.state.tracks.find((t) => t.chapter === current.chapter)!;
      if (this.state.seq > start.seq || this.state.ms > 4000) return void this.start(start.seq);
      const previous = this.state.tracks.filter((t) => t.chapter < current.chapter).pop();
      if (previous) {
        const first = this.state.tracks.find((t) => t.chapter === previous.chapter)!;
        void this.start(first.seq);
      }
    } else {
      const next = this.state.tracks.find((t) => t.chapter > current.chapter);
      if (next) void this.start(next.seq);
    }
  }

  setRate(rate: number) {
    this.audio.playbackRate = rate;
    this.set({ rate });
  }

  private markAt(marks: Mark[], ms: number) {
    let low = 0;
    let high = marks.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const mark = marks[middle];
      if (ms < mark[3]) high = middle - 1;
      else if (ms > mark[4]) low = middle + 1;
      else return mark;
    }
    return marks[Math.max(0, high)];
  }

  private tick() {
    const ms = this.audio.currentTime * 1000;
    const detail = this.details.get(this.state.seq);
    const mark = detail ? this.markAt(detail.marks, ms) : undefined;
    const current = this.state.mark;
    const next = mark ? { block: mark[0], start: mark[1], end: mark[2] } : null;
    const same = current && next && current.block === next.block && current.start === next.start;
    this.set({ ms, mark: same ? current : next });
    if (!this.saveTimer) {
      this.saveTimer = window.setTimeout(() => {
        this.saveTimer = 0;
        this.persist();
      }, 5000);
    }
  }

  private persist() {
    if (this.state.book) void api.saveListen(this.state.book, this.state.seq, Math.round(this.state.ms)).catch(() => {});
  }

  /** Detaches when a book's audio is removed. */
  clear(book: string) {
    if (this.state.book !== book) return;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.details.clear();
    this.set({ ...initial, rate: this.state.rate });
  }
}

export const player = new Player();

export function usePlayer() {
  return useSyncExternalStore(player.subscribe, player.snapshot);
}
