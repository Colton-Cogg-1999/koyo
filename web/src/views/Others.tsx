import { useEffect, useMemo, useState } from 'react';
import { FileText, FolderOpen, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, onServerEvent, urls } from '../api';
import { player, usePlayer } from '../audio';
import { renderMarkdown } from '../markdown';
import { TypePanel } from '../reader/TypePanel';
import { stored, saveLocal } from '../preferences';
import { NoteSheet } from '../reader/Margin';
import { navigate } from '../route';
import { setThemeMode, themeMode } from '../theme';
import { defaultPrefs, type ReaderPrefs, type Annotation, type Note } from '../types';
import { bytes, clock, Cover, Empty, failure, Gauge, Pane, toast, useAsync, when } from '../ui';

export function Annotations() {
  const [items, reload] = useAsync(() => api.annotations(), []);
  const [kind, setKind] = useState('All');
  const [query, setQuery] = useState('');
  const [book, setBook] = useState('');
  const [editing, setEditing] = useState<Annotation | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const map = new Map<string, Annotation[]>();
    for (const item of [...(items ?? [])].sort((a,b) => a.block - b.block || a.created_at - b.created_at)) {
      if (book && item.book_id !== book) continue;
      if (kind === 'Notes' && !item.note) continue;
      if (kind === 'Highlights' && (item.kind !== 'highlight' || JSON.parse(item.anchor).kind === 'bookmark')) continue;
      if (kind === 'Bookmarks' && item.kind !== 'bookmark') continue;
      if (needle && !`${item.quote} ${item.note} ${item.book_title} ${item.chapter}`.toLowerCase().includes(needle)) continue;
      map.set(item.book_id, [...(map.get(item.book_id) ?? []), item]);
    }
    return [...map.values()];
  }, [items, kind, query, book]);
  const edit = (item: Annotation) => { setEditing(item); setDraft(stored(`mark-draft:${item.id}`, item.note)); };
  const save = async () => {
    if (!editing || saving) return;
    setSaving(true);
    try { await api.updateAnnotation(editing.id, { note: draft }); localStorage.removeItem(`omareader:mark-draft:${editing.id}`); setEditing(null); reload(); }
    catch (error) { failure(error); } finally { setSaving(false); }
  };
  return <Pane className="full marks-view" title="Marks" tools={<><a className="ghost" href="/api/annotations/export.md" download>Export Markdown</a><button className="ghost" onClick={() => navigate('notebook')}>Saved writing</button></>}>
    <div className="marks-tools">
      <input type="search" aria-label="Filter marks" placeholder="Search marks" value={query} onChange={(e) => setQuery(e.target.value)} />
      <select aria-label="Filter marks by book" value={book} onChange={(e) => setBook(e.target.value)}><option value="">All books</option>{[...new Map(items?.map((i) => [i.book_id, i.book_title])).entries()].map(([id,title]) => <option key={id} value={id}>{title}</option>)}</select>
      <div className="tabs">{['All','Highlights','Notes','Bookmarks'].map((k) => <button key={k} className={`tab ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{k}</button>)}</div>
    </div>
    <div className="scroll">
      {groups.map((list) => <section className="mark-group" key={list[0].book_id}>
        <header><h2>{list[0].book_title}</h2><span>{list[0].book_author}</span><a className="ghost" href={urls.notesMarkdown(list[0].book_id)} download><FileText size={13} /> .md</a></header>
        {list.map((item) => <article key={item.id} className="mark-entry">
          <button className="passage" onClick={() => navigate(`read/${item.book_id}?b=${item.block}&p=${item.page}`)}>
            <small>{item.kind === 'bookmark' ? 'Bookmark · ' : ''}{item.chapter || 'Location'} · {item.page ? `p. ${item.page}` : `Location ${item.block + 1}`}</small>
            {item.quote && <blockquote>{item.quote}</blockquote>}{item.note && <p>{item.note}</p>}
          </button>
          {editing?.id === item.id ? <div className="mark-editor"><textarea autoFocus aria-label="Edit mark note" value={draft} onChange={(e) => { setDraft(e.target.value); saveLocal(`mark-draft:${item.id}`,e.target.value); }} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(null); }} /><button className="ghost" disabled={saving} onClick={() => void save()}>Save</button><button className="ghost" onClick={() => setEditing(null)}>Cancel</button></div> : <button className="ghost" onClick={() => edit(item)}>Edit note</button>}
          <button className="ghost danger" onClick={() => { if (window.confirm('Delete this mark and its note?')) void api.deleteAnnotation(item.id).then(reload).catch(failure); }}>Delete</button>
        </article>)}
      </section>)}
      {items && !groups.length && <p className="hint">No marks here.</p>}
    </div>
  </Pane>;
}

export function Audiobooks() {
  const [rows, reload] = useAsync(() => api.audiobooks(), []);
  const audio = usePlayer();
  useEffect(() => onServerEvent((event) => {
    if (event.type === 'audio') reload();
  }), []);
  return (
    <Pane className="full" title="Audio">
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
  const [prefs, setPrefs] = useState<ReaderPrefs>(defaultPrefs);
  useEffect(() => { void api.settings().then((s) => setPrefs({ ...defaultPrefs, ...(s.reader as Partial<ReaderPrefs> ?? {}) })).catch(failure); }, []);

  const recheck = async () => {
    setChecking(true);
    await api.providers(true).then(setProviders).catch(failure);
    setChecking(false);
  };

  const chooseTheme = (next: 'olive' | 'system') => {
    setMode(next);
    setThemeMode(next);
    void api.saveSettings({ theme: next }).catch(failure);
  };

  return (
    <Pane className="full" title="Settings">
      <div className="scroll settings">
        <section className="settings-reading"><h2>Reading</h2><TypePanel prefs={prefs} pdf={false} onClose={() => {}} onChange={(patch) => { const next = { ...prefs, ...patch }; setPrefs(next); void api.saveSettings({ reader: next }).catch(failure); }} /></section>
        <section><h2>Keyboard</h2><dl className="paths"><dt>Command palette</dt><dd>Ctrl+Shift+P</dd><dt>Find in book</dt><dd>Ctrl+F</dd><dt>Library</dt><dd>Ctrl+L</dd><dt>Bookmark</dt><dd>Ctrl+D</dd><dt>Sidebar</dt><dd>Ctrl+B</dd><dt>Ask this book</dt><dd>Ctrl+J</dd><dt>Page movement</dt><dd>Page Up / Page Down</dd></dl></section>
        <section>
          <h2>Appearance</h2>
          <div className="choices">
            <button className={mode === 'olive' ? 'on' : ''} onClick={() => chooseTheme('olive')}>OmaReader dark</button>
            <button className={mode === 'system' ? 'on' : ''} onClick={() => chooseTheme('system')}>follow system{theme?.name ? ` (${theme.name})` : ''}</button>
          </div>
          <p className="hint">follow system tracks <code>omarchy theme set</code> live.</p>
        </section>

        <section>
          <h2>Library storage</h2>
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
          <h2 id="ai-settings">AI</h2>
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
          <h2>Audio</h2>
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
