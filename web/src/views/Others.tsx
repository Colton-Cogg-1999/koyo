import { useEffect, useMemo, useState } from 'react';
import { FileText, FolderOpen, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, onServerEvent, urls } from '../api';
import { player, usePlayer } from '../audio';
import { renderMarkdown } from '../markdown';
import { NoteSheet } from '../reader/Margin';
import { navigate } from '../route';
import { setThemeMode, themeMode } from '../theme';
import type { Color, Note } from '../types';
import { bytes, clock, Cover, Empty, failure, Gauge, Pane, toast, useAsync, when } from '../ui';

export function Annotations() {
  const [items] = useAsync(() => api.annotations({ kind: 'highlight' }), []);
  const [color, setColor] = useState<Color | null>(null);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const needle = query.toLowerCase();
    const map = new Map<string, NonNullable<typeof items>>();
    for (const item of items ?? []) {
      if (color && item.color !== color) continue;
      if (needle && !`${item.quote} ${item.note}`.toLowerCase().includes(needle)) continue;
      map.set(item.book_id, [...(map.get(item.book_id) ?? []), item]);
    }
    return [...map.values()];
  }, [items, color, query]);
  return (
    <Pane
      className="full"
      title="MARKS"
      tools={
        <>
          {(['blue', 'green', 'pink', 'yellow'] as Color[]).map((c) => (
            <button key={c} className={`swatch ${c} ${color === c ? 'on' : ''}`} title={c} onClick={() => setColor(color === c ? null : c)} />
          ))}
          <input type="search" aria-label="Filter marks" placeholder="filter" value={query} onChange={(event) => setQuery(event.target.value)} />
        </>
      }
    >
      <div className="scroll">
        {groups.map((list) => (
          <section className="mark-group" key={list[0].book_id}>
            <header>
              <h2>{list[0].book_title}</h2>
              <span>{list[0].book_author}</span>
              <a className="ghost" href={urls.notesMarkdown(list[0].book_id)} download><FileText size={13} /> .md</a>
            </header>
            {list.map((item) => (
              <button key={item.id} className={`passage ${item.color}`} onClick={() => navigate(`read/${item.book_id}?b=${item.block}`)}>
                <blockquote>{item.quote}</blockquote>
                {item.note && <em>{item.note}</em>}
                <small>{item.chapter}{item.page ? ` :: p.${item.page}` : ''} :: {when(item.created_at)}</small>
              </button>
            ))}
          </section>
        ))}
        {items && !groups.length && <Empty title="no marks">select text while reading to highlight or annotate.</Empty>}
      </div>
    </Pane>
  );
}

export function Audiobooks() {
  const [rows, reload] = useAsync(() => api.audiobooks(), []);
  const audio = usePlayer();
  useEffect(() => onServerEvent((event) => {
    if (event.type === 'audio') reload();
  }), []);
  return (
    <Pane className="full" title="AUDIOBOOKS">
      <div className="scroll">
        {rows?.map((row) => {
          const active = audio.book === row.book_id;
          return (
            <div className="audio-row" key={row.book_id}>
              <button className="audio-open" onClick={() => navigate(`read/${row.book_id}`)}>
                <Cover book={{ id: row.book_id, title: row.title, has_cover: row.has_cover }} />
                <div>
                  <strong>{row.title}</strong>
                  <span><Gauge value={row.total ? row.ready / row.total : 0} /> {row.ready}/{row.total} :: {clock(row.duration_ms)} :: {row.status}</span>
                  {row.error && <span className="error">ERR&gt; {row.error}</span>}
                </div>
              </button>
              <button className="play" title="Play or pause" onClick={() => {
                if (active) return player.toggle();
                void player.load(row.book_id, row.title).then(() => player.play()).catch(failure);
              }}>{active && audio.playing ? <Pause size={17} /> : <Play size={17} />}</button>
              <button className="icon" title="Delete audio" onClick={() => {
                if (!window.confirm(`Delete the audio for "${row.title}"? The book stays.`)) return;
                player.clear(row.book_id);
                void api.deleteAudio(row.book_id).then(reload).catch(failure);
              }}><Trash2 size={15} /></button>
            </div>
          );
        })}
        {rows && !rows.length && <Empty title="no audiobooks">open a book and press start narrating.</Empty>}
      </div>
    </Pane>
  );
}

export function Notebook() {
  const [notes, reload] = useAsync(() => api.notes(), []);
  const [open, setOpen] = useState<Note | null>(null);
  return (
    <Pane className="full" title="NOTEBOOK" tools={<button className="solid" onClick={() => void api.createNote({}).then(setOpen).catch(failure)}><Plus size={13} /> new</button>}>
      {open ? (
        <div className="scroll"><NoteSheet key={open.id} note={open} onBack={() => { setOpen(null); reload(); }} /></div>
      ) : (
        <div className="scroll">
          <div className="note-cards">
            {notes?.map((note) => (
              <button key={note.id} className="note-card" onClick={() => setOpen(note)}>
                <h3>{note.title || 'untitled'}</h3>
                <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(note.body.slice(0, 380)) }} />
                <small>{note.book_title ?? 'loose'} :: {when(note.updated_at)}</small>
              </button>
            ))}
          </div>
          {notes && !notes.length && <Empty title="notebook empty">write here, or save Oma's answers while reading.</Empty>}
        </div>
      )}
    </Pane>
  );
}

export function Settings() {
  const [providers, , setProviders] = useAsync(() => api.providers(), []);
  const [storage] = useAsync(() => api.storage(), []);
  const [tts, reloadTts] = useAsync(() => api.tts(), []);
  const [theme] = useAsync(() => api.theme(), []);
  const [mode, setMode] = useState(themeMode());
  const [checking, setChecking] = useState(false);

  const recheck = async () => {
    setChecking(true);
    await api.providers(true).then(setProviders).catch(failure);
    setChecking(false);
  };

  const chooseTheme = (next: 'neon' | 'system') => {
    setMode(next);
    setThemeMode(next);
    void api.saveSettings({ theme: next }).catch(failure);
  };

  return (
    <Pane className="full" title="SYS">
      <div className="scroll settings">
        <section>
          <h2>THEME</h2>
          <div className="choices">
            <button className={mode === 'neon' ? 'on' : ''} onClick={() => chooseTheme('neon')}>omarchy neon</button>
            <button className={mode === 'system' ? 'on' : ''} onClick={() => chooseTheme('system')}>follow system{theme?.name ? ` (${theme.name})` : ''}</button>
          </div>
          <p className="hint">follow system tracks <code>omarchy theme set</code> live.</p>
        </section>

        <section>
          <h2>LIBRARY STORAGE</h2>
          <p className="hint">OmaReader keeps its own persistent library on this device. Imported books, notes, highlights, and reading positions remain when you close the app. You can move or delete the original files after importing. Use Export original to take a book back out.</p>
          {storage && (
            <>
              <dl className="paths">
                <dt>books</dt><dd><code>{storage.books_dir}</code></dd>
                <dt>data</dt><dd><code>{storage.data_dir}</code></dd>
                <dt>notes</dt><dd><code>{storage.notes_dir}</code> <span className="hint">mirrored as markdown on every change</span></dd>
              </dl>
              <p className="hint">For a checked backup, close the app and run <code>omareader backup /path/to/new-backup</code>. Restore into a new folder with <code>omareader restore /path/to/backup /path/to/new-library</code>. Set <code>OMAREADER_DATA_DIR</code> to the restored folder when launching. Backups include generated audio; voice models download again. Existing folders are never overwritten.</p>
              <table className="sizes">
                <tbody>
                  <tr><td>books</td><td>{bytes(storage.books_bytes)}</td></tr>
                  <tr><td>notes + index</td><td>{bytes(storage.db_bytes)}</td></tr>
                  <tr><td>audio</td><td>{bytes(storage.audio_bytes)}</td></tr>
                  <tr><td>voices</td><td>{bytes(storage.models_bytes)}</td></tr>
                </tbody>
              </table>
              <button className="ghost" onClick={() => void api.openLibraryFolder().catch(failure)}>Open books folder</button>
              <button className="ghost" onClick={() => void api.openNotesFolder().catch(failure)}><FolderOpen size={13} /> open notes folder</button>
              <p className="hint">opens {storage.formats.map((f) => `.${f}`).join(' ')}. {storage.calibre_installed ? 'calibre adds' : 'installing calibre adds'} {storage.calibre_formats.slice(0, 6).map((f) => `.${f}`).join(' ')} and more.</p>
            </>
          )}
        </section>

        <section>
          <h2>AGENT</h2>
          <p className="hint">optional: ask questions through your installed Claude Code or Codex CLI. questions, retrieved book passages, and recent chat history go to that provider. requests run with tools disabled; provider credentials are managed by the CLI.</p>
          <div className="provider-cards">
            {providers?.providers.map((p) => (
              <div key={p.id} className={`provider ${providers.selected === p.id ? 'on' : ''}`}>
                <h3>{p.name}</h3>
                <span className={p.signed_in ? 'ok' : 'off'}>{p.signed_in ? `online${p.plan ? ` :: ${p.plan}` : ''}` : p.installed ? 'not signed in' : 'not installed'}</span>
                {!p.signed_in && <p className="hint">{p.help}</p>}
                {p.signed_in && (
                  <>
                    <select aria-label={`${p.name} model`} value={providers.selected === p.id ? providers.model : ''} onChange={(event) => {
                      void api.saveSettings({ ai_provider: p.id, ai_model: event.target.value }).then(() => setProviders({ ...providers, selected: p.id, model: event.target.value })).catch(failure);
                    }}>
                      {p.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                    {providers.selected !== p.id && (
                      <button className="ghost" onClick={() => void api.saveSettings({ ai_provider: p.id, ai_model: '' }).then(() => setProviders({ ...providers, selected: p.id, model: '' })).catch(failure)}>use {p.name}</button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <button className="ghost" disabled={checking} onClick={() => void recheck()}><RefreshCw size={13} /> re-check</button>
        </section>

        <section>
          <h2>NARRATION</h2>
          <p className="hint">{tts?.installed ? 'voice engine installed. audio is generated locally at low priority.' : 'voices download from the audiobook pane on first use.'}</p>
          {tts && (
            <label className="row-field">threads
              <select value={tts.threads ?? ''} onChange={(event) => {
                const value = event.target.value ? Number(event.target.value) : null;
                void api.saveSettings({ tts_threads: value }).then(reloadTts).then(() => toast('applies after restart')).catch(failure);
              }}>
                <option value="">auto</option>
                {[2, 4, 6, 8, 10, 12].filter((n) => n <= tts.cores).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
        </section>
      </div>
    </Pane>
  );
}
