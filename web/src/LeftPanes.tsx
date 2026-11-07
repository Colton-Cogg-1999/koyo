import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Play, Pause, SkipBack, SkipForward, Square, Volume2 } from 'lucide-react';
import { api, onServerEvent, urls } from './api';
import { player, usePlayer } from './audio';
import { navigate, type Route } from './route';
import { useSession } from './session';
import type { Book, Voice } from './types';
import { bytes, clock, failure, Logo, Pane, toast, useAsync } from './ui';

export const WORKSPACES: { key: string; label: string; path: string; match: Route['view'] }[] = [
  { key: '1', label: 'LIB', path: 'library', match: 'library' },
  { key: '2', label: 'READ', path: '', match: 'read' },
  { key: '3', label: 'MARKS', path: 'annotations', match: 'annotations' },
  { key: '4', label: 'AUDIO', path: 'audiobooks', match: 'audiobooks' },
  { key: '5', label: 'NOTES', path: 'notebook', match: 'notebook' },
  { key: '6', label: 'SYS', path: 'settings', match: 'settings' },
];

export function NowPane({ route, latest, onWorkspace }: { route: Route; latest?: Book; onWorkspace: (path: string) => void }) {
  const { book, location, seek } = useSession();
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = book ?? latest;
  const ratio = scrub ?? (book ? location.ratio : latest?.progress ?? 0);
  const page = book?.format === 'pdf' ? location.page : shown ? Math.max(1, Math.ceil(ratio * shown.pages)) : 0;
  return (
    <Pane className="now">
      <button className="brand" onClick={() => navigate('library')} title="Library">
        <Logo height={30} />
      </button>
      <nav className="workspaces">
        {WORKSPACES.map((space) => (
          <button key={space.key} className={route.view === space.match ? 'on' : ''} title={`${space.label} (${space.key})`} onClick={() => onWorkspace(space.path)}>
            <b>{space.key}</b>{space.label}
          </button>
        ))}
      </nav>
      {shown ? (
        <button className="now-text" disabled={!!book} onClick={() => navigate(`read/${shown.id}`)}>
          <span>NOW READING: <em>{shown.title}</em></span>
          {shown.author && <span>AUTHOR: <em>{shown.author}</em></span>}
        </button>
      ) : (
        <div className="now-text"><span>NOW READING: <em>nothing</em></span></div>
      )}
      <div className="progress">
        <input
          type="range" min={0} max={1000} aria-label="Position in book" disabled={!book}
          style={{ '--at': `${ratio * 100}%` } as React.CSSProperties}
          value={Math.round(ratio * 1000)}
          onChange={(event) => setScrub(Number(event.target.value) / 1000)}
          onPointerUp={() => {
            if (scrub !== null) seek(scrub);
            setScrub(null);
          }}
        />
      </div>
      <div className="page-count">{shown ? `Pg ${page} / ${shown.pages}` : '—'}<span>{Math.round(ratio * 100)}%</span></div>
    </Pane>
  );
}

function useInstall(reload: () => void) {
  const [install, setInstall] = useState<{ stage: string; done: number; total: number } | null>(null);
  useEffect(() => onServerEvent((event) => {
    if (event.type !== 'tts_install') return;
    setInstall(event as never);
    if (event.stage === 'done') reload();
    if (event.stage === 'failed') toast(event.error, 'error');
  }), []);
  return { install, setInstall };
}

function Wave({ peaks, progress, made, onSeek }: { peaks: number[]; progress: number; made: number; onSeek: (ratio: number) => void }) {
  const count = 54;
  const bars = useMemo(() => Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i / count) * peaks.length);
    const to = Math.max(from + 1, Math.floor(((i + 1) / count) * peaks.length));
    const slice = peaks.slice(from, to);
    return slice.length ? Math.max(...slice) : 0;
  }), [peaks]);
  return (
    <div className="wave" role="slider" aria-label="Chapter position" aria-valuenow={Math.round(progress * 100)} tabIndex={0} onClick={(event) => {
      const box = event.currentTarget.getBoundingClientRect();
      onSeek((event.clientX - box.left) / box.width);
    }}>
      {bars.map((value, i) => {
        const at = i / count;
        return <i key={i} className={at <= progress ? 'played' : at < made ? '' : 'unmade'} style={{ height: `${Math.max(4, value)}%` }} />;
      })}
    </div>
  );
}

function VoicePicker({ voices, value, onChange }: { voices: Voice[]; value: string; onChange: (id: string) => void }) {
  const preview = useRef<HTMLAudioElement | null>(null);
  const groups = useMemo(() => {
    const map = new Map<string, Voice[]>();
    for (const voice of voices) {
      const key = `${voice.accent} ${voice.gender.toLowerCase()}`;
      map.set(key, [...(map.get(key) ?? []), voice]);
    }
    return [...map];
  }, [voices]);
  return (
    <div className="voice-row">
      <select aria-label="Narrator" value={value} onChange={(event) => onChange(event.target.value)}>
        {groups.map(([label, list]) => (
          <optgroup key={label} label={label}>
            {list.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
          </optgroup>
        ))}
      </select>
      <button className="ghost" title="Hear this voice" onClick={() => {
        preview.current?.pause();
        preview.current = new Audio(urls.preview(value));
        void preview.current.play().catch(() => toast('the sample could not play', 'error'));
      }}><Volume2 size={14} /></button>
    </div>
  );
}

function eta(seconds: number) {
  if (seconds < 90) return '~1m';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `~${minutes}m` : `~${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function AudioPane({ fallbackBookId }: { fallbackBookId?: string }) {
  const session = useSession();
  const audio = usePlayer();
  const [status, reloadStatus] = useAsync(() => api.tts(), []);
  const { install, setInstall } = useInstall(reloadStatus);
  const bookId = session.book?.id ?? audio.book ?? fallbackBookId;
  const [storedBook] = useAsync(() => bookId ? api.book(bookId) : Promise.resolve(null), [bookId]);
  const book = session.book ?? (storedBook?.id === bookId ? storedBook : null);
  const block = session.book ? session.location.block : book?.position?.block ?? 0;
  const [summary, reload] = useAsync(() => (bookId ? api.audio(bookId) : Promise.resolve(null)), [bookId]);
  const [progress, setProgress] = useState<{ eta: number | null } | null>(null);
  const [voice, setVoice] = useState('');
  const [changing, setChanging] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [peaks, setPeaks] = useState<number[]>([]);
  const attached = !!bookId && audio.book === bookId;

  useEffect(() => {
    if (status && !voice) setVoice(status.default_voice);
  }, [status]);

  useEffect(() => onServerEvent((event) => {
    if (event.book_id !== bookId) return;
    if (event.type === 'audio') {
      if (event.status === 'generating') setProgress({ eta: event.eta ?? null });
      reload();
    }
    if (event.type === 'audio_export') {
      setExporting(false);
      if (event.status === 'done') {
        reload();
        toast('.m4b ready to download');
      } else toast(event.error, 'error');
    }
  }), [bookId]);

  const tracks = attached && audio.tracks.length ? audio.tracks : summary?.tracks ?? [];
  const current = tracks[audio.seq];
  const chapterIndex = current?.chapter;
  const readyHere = tracks.filter((t) => t.chapter === chapterIndex && t.ready).length;

  useEffect(() => {
    if (chapterIndex === undefined || !bookId) return;
    let live = true;
    const inChapter = tracks.filter((t) => t.chapter === chapterIndex);
    Promise.all(inChapter.map(async (track) => {
      if (!track.ready) return new Array<number>(Math.round((track.chars / 15) * 4)).fill(0);
      return (await api.trackDetail(bookId, track.seq)).peaks;
    })).then((lists) => live && setPeaks(lists.flat())).catch(() => {});
    return () => {
      live = false;
    };
  }, [chapterIndex, readyHere, bookId]);

  const start = async (fromBlock?: number) => {
    if (!book) return;
    const started = await api.startAudio(book.id, voice, fromBlock ?? block);
    reload();
    await player.load(book.id, book.title);
    await player.refresh();
    player.cue(started.cursor ?? 0);
    setChanging(false);
  };

  const title = `KOKORO AUDIOBOOK${book ? ` // ${book.title}` : ''}`;
  if (!status) return <Pane title={title} className="audio"><p className="hint">loading…</p></Pane>;
  if (!status.ffmpeg) return <Pane title={title} className="audio"><p className="hint">requires ffmpeg: <code>sudo pacman -S ffmpeg</code></p></Pane>;

  if (!status.installed) {
    const percent = install?.total ? Math.round((install.done / install.total) * 100) : 0;
    const busy = install && install.stage !== 'failed' && install.stage !== 'done';
    return (
      <Pane title={title} className="audio">
        <p className="hint">local neural narration. one-time voice download of several hundred MB. narration runs on this machine.</p>
        {busy ? (
          <div className="meter"><i style={{ width: `${percent}%` }} /><span>{install.stage === 'unpack' ? 'unpacking…' : `${percent}% of ${bytes(install.total)}`}</span></div>
        ) : (
          <button className="solid wide" onClick={() => { setInstall({ stage: 'download', done: 0, total: 350e6 }); void api.installTts().catch(failure); }}>download voices</button>
        )}
      </Pane>
    );
  }

  const idle = !summary || summary.status === 'none' || !tracks.length;
  if (!bookId || (idle && !book)) return <Pane title={title} className="audio"><p className="hint">open a book to narrate it.</p></Pane>;

  if (idle) {
    const minutes = book ? Math.round(book.chars / 15 / 60) : 0;
    return (
      <Pane title={title} className="audio">
        <p className="hint">~{minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`} of narration, ~{Math.max(1, Math.round(minutes / 3))}m to generate. starts where you are reading.</p>
        <VoicePicker voices={status.voices} value={voice} onChange={setVoice} />
        <button className="solid wide" onClick={() => void start().catch(failure)}>start narrating</button>
      </Pane>
    );
  }

  const ready = tracks.filter((t) => t.ready).length;
  const total = tracks.length;
  const generating = summary.status === 'generating';
  const chapter = book?.chapters.find((c) => c.idx === chapterIndex);
  const timing = attached ? player.chapterTiming() : { elapsed: 0, total: 0 };
  const voiceInfo = status.voices.find((v) => v.id === summary.voice);
  const ratio = timing.total ? timing.elapsed / timing.total : 0;
  const inChapter = tracks.filter((t) => t.chapter === chapterIndex);
  const made = inChapter.length ? readyHere / inChapter.length : 0;
  const playing = audio.playing || audio.waiting;

  return (
    <Pane title={title} className="audio" tools={<button className="tab" onClick={() => setChanging(!changing)}>{voiceInfo?.name ?? 'voice'}</button>}>
      {changing && (
        <div className="voice-change">
          <VoicePicker voices={status.voices} value={voice} onChange={setVoice} />
          <button className="solid wide" disabled={voice === summary.voice} onClick={() => void start().catch(failure)}>re-narrate (replaces audio)</button>
        </div>
      )}
      <div className="transport">
        <button className="play" title="Play or pause (l)" onClick={() => {
          if (!attached && bookId) return void player.load(bookId, book?.title ?? audio.title).then(() => player.toggle());
          player.toggle();
        }}>{playing ? <Pause size={22} /> : <Play size={22} />}</button>
        <button className="stop" title="Stop and go to chapter start" onClick={() => {
          if (audio.playing) player.toggle();
          player.seekChapterStart();
        }}><Square size={13} /></button>
        <span />
        <button className="icon" title="Previous chapter" onClick={() => player.stepChapter(-1)}><SkipBack size={15} /></button>
        <button className="icon" title="Back 15 seconds" onClick={() => player.skip(-15)}>-15</button>
        <button className="icon" title="Forward 15 seconds" onClick={() => player.skip(15)}>+15</button>
        <button className="icon" title="Next chapter" onClick={() => player.stepChapter(1)}><SkipForward size={15} /></button>
      </div>
      <Wave peaks={peaks} progress={ratio} made={made} onSeek={(r) => player.seekChapter(r * timing.total)} />
      <div className="seek"><i style={{ width: `${ratio * 100}%` }} /></div>
      <div className="times">
        <select className="rate" aria-label="Speed" value={audio.rate} onChange={(event) => player.setRate(Number(event.target.value))}>
          {[0.8, 1, 1.15, 1.3, 1.5, 1.75, 2].map((rate) => <option key={rate} value={rate}>{rate}x</option>)}
        </select>
        <span>{clock(timing.elapsed)} / {clock(timing.total)}</span>
      </div>
      <p className="audio-chapter">{chapter?.title ?? audio.title}</p>
      {audio.waiting && <p className="hint">synthesizing this part. playback starts on its own.</p>}
      {book && <button className="ghost wide" onClick={() => void start(block).then(() => player.playBlock(block)).catch(failure)}>&gt; listen from here</button>}
      <div className="gen-status">
        {summary.status === 'failed' ? (
          <p className="error">ERR&gt; {summary.error}</p>
        ) : ready < total ? (
          <>
            <div className="meter"><i style={{ width: `${(ready / total) * 100}%` }} /><span>{generating ? `${ready}/${total} parts ${progress?.eta ? eta(progress.eta) : ''}` : `paused ${ready}/${total}`}</span></div>
            {generating
              ? <button className="ghost" onClick={() => void api.pauseAudio(bookId).then(reload).catch(failure)}>pause</button>
              : <button className="ghost" onClick={() => void start().catch(failure)}>resume</button>}
          </>
        ) : summary.has_export ? (
          <a className="ghost wide" href={urls.audioDownload(bookId)} download><Download size={13} /> download .m4b</a>
        ) : (
          <button className="ghost wide" disabled={exporting} onClick={() => { setExporting(true); void api.exportAudio(bookId).catch((e) => { setExporting(false); failure(e); }); }}>
            <Download size={13} /> {exporting ? 'building…' : 'build .m4b'}
          </button>
        )}
      </div>
    </Pane>
  );
}
