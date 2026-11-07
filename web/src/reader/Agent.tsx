import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { api, ask } from '../api';
import { renderMarkdown } from '../markdown';
import type { Location } from '../session';
import type { BookDetail, ChatSummary, Citation, Message, Providers } from '../types';
import { failure, Pane, toast, useAsync } from '../ui';

const COMMANDS: Record<string, { question: string; label: string; scope?: 'chapter' | 'book'; hint: string }> = {
  '/summarize': { question: 'Summarize this chapter: its argument or events, and what matters most.', label: '/summarize', scope: 'chapter', hint: 'this chapter' },
  '/ideas': { question: 'What are the central ideas of this book, and how do they build on each other?', label: '/ideas', scope: 'book', hint: 'the whole book' },
  '/quiz': { question: 'Write five thought-provoking questions on this chapter to test my understanding. Do not give the answers yet.', label: '/quiz', scope: 'chapter', hint: 'test yourself' },
};
const LOCAL = ['/new', '/clear', '/model'];

function Answer({ message, go, onSave }: { message: Message; go: (block: number) => void; onSave: () => void }) {
  const html = useMemo(() => renderMarkdown(message.content, true), [message.content]);
  const byNumber = useMemo(() => new Map<string, Citation>(message.citations.map((c) => [String(c.n), c])), [message.citations]);
  return (
    <div className="answer">
      <span className="who">OMA:</span>
      <div
        className="markdown"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={(event) => {
          const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cite]');
          const citation = target && byNumber.get(target.dataset.cite!);
          if (citation) go(citation.block);
        }}
        onMouseOver={(event) => {
          const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cite]');
          const citation = target && byNumber.get(target.dataset.cite!);
          if (target && citation) target.title = `${citation.chapter}: ${citation.quote}`;
        }}
      />
      {message.error && <p className="error">ERR&gt; {message.error}</p>}
      {message.content && <button className="save" onClick={onSave}>[save to notebook]</button>}
    </div>
  );
}

export function Agent({ book, location, seed, go }: { book: BookDetail; location: Location; seed: { selection: string; question?: string; nonce: number } | null; go: (block: number) => void }) {
  const [providers, , setProviders] = useAsync<Providers>(() => api.providers(), []);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [selection, setSelection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [large, setLarge] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const handled = useRef(0);

  useEffect(() => {
    api.chats(book.id).then((list) => {
      setChats(list);
      if (list[0]) setChat(list[0].id);
    }).catch(failure);
  }, [book.id]);

  useEffect(() => {
    if (chat && !busy) api.messages(chat).then(setMessages).catch(failure);
    if (!chat) setMessages([]);
  }, [chat]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'i' && !(event.target as HTMLElement).closest('input,textarea') && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        field.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = async (question: string, options: { label?: string; scope?: 'chapter' | 'book'; selection?: string | null } = {}) => {
    const text = question.trim();
    if (!text || busy) return;
    const quoted = options.selection !== undefined ? options.selection : selection;
    setInput('');
    setSelection(null);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      let id = chat;
      if (!id) {
        const created = await api.createChat(book.id);
        id = created.id;
        setChats((list) => [created, ...list]);
        setChat(id);
      }
      const user: Message = { role: 'user', content: options.label ?? text, citations: [] };
      setMessages((list) => [...list, user, { role: 'assistant', content: '', citations: [] }]);
      const update = (change: (m: Message) => Message) => setMessages((list) => [...list.slice(0, -1), change(list[list.length - 1])]);
      await ask(id, { question: text, label: options.label, selection: quoted ?? undefined, block: location.block, scope: options.scope }, (event) => {
        if (event.type === 'citations') update((m) => ({ ...m, citations: event.citations }));
        if (event.type === 'delta') update((m) => ({ ...m, content: m.content + event.text }));
        if (event.type === 'error') update((m) => ({ ...m, error: event.message }));
      }, controller.signal);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setMessages((list) => [...list.slice(0, -1), { ...list[list.length - 1], error: (error as Error).message }]);
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const submit = () => {
    const text = input.trim();
    if (text === '/new' || text === '/clear') {
      setInput('');
      setChat(null);
      setMessages([]);
      return;
    }
    if (text === '/model') {
      setInput('');
      setMenu(true);
      return;
    }
    const command = COMMANDS[text];
    if (command) void send(command.question, command);
    else void send(input);
  };

  useEffect(() => {
    if (!seed || handled.current === seed.nonce) return;
    handled.current = seed.nonce;
    if (seed.question) void send(seed.question, { selection: seed.selection, label: `${seed.question} "${seed.selection.slice(0, 120)}"` });
    else {
      setSelection(seed.selection);
      field.current?.focus();
    }
  }, [seed]);

  const selected = providers?.providers.find((p) => p.id === providers.selected) ?? null;
  const usable = providers?.providers.filter((p) => p.signed_in) ?? [];

  const pick = async (id: string, model = '') => {
    await api.saveSettings({ ai_provider: id, ai_model: model });
    setProviders((current) => (current ? { ...current, selected: id, model } : current));
    setMenu(false);
  };

  const saveNote = async (message: Message) => {
    const question = messages[messages.indexOf(message) - 1]?.content ?? 'From Oma';
    const cited = message.content.replace(/\[(\d{1,3})\]/g, (whole, n) => {
      const citation = message.citations.find((c) => String(c.n) === n);
      return citation ? ` (${citation.chapter}${citation.page ? `, p. ${citation.page}` : ''})` : whole;
    });
    await api.createNote({ book_id: book.id, title: question.split('\n')[0].slice(0, 90), body: cited });
    toast('saved to notebook');
  };

  const suggestions = input.startsWith('/') ? [...Object.keys(COMMANDS), ...LOCAL].filter((c) => c.startsWith(input.trim())) : [];

  return (
    <Pane
      className={`agent ${large ? 'large' : ''}`}
      title={<>AI AGENT <i>// {selected?.name ?? 'offline'}</i></>}
      tools={
        <>
          <button className="tab" onClick={() => setMenu(!menu)}>model</button>
          {chats.length > 1 && (
            <select aria-label="Conversation" value={chat ?? ''} onChange={(event) => setChat(event.target.value)}>
              {chats.map((c) => <option key={c.id} value={c.id}>{c.title || 'new'}</option>)}
            </select>
          )}
          <button className="icon" title="Resize" onClick={() => setLarge(!large)}>{large ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
        </>
      }
    >
      {menu && (
        <div className="popover provider-menu">
          {providers?.providers.map((p) => (
            <section key={p.id}>
              <h4>{p.name}{p.plan ? ` [${p.plan}]` : ''}</h4>
              {p.signed_in ? p.models.map((m) => (
                <button key={m.id} className={p.id === providers.selected && m.id === providers.model ? 'on' : ''} onClick={() => void pick(p.id, m.id).catch(failure)}>{m.label}</button>
              )) : <p className="hint">{p.help}</p>}
            </section>
          ))}
        </div>
      )}
      <div className="chat-log" ref={log}>
        {providers && usable.length === 0 && (
          <div className="answer">
            <span className="who">SYS:</span>
            <p>no signed-in agent found. oma uses your own CLI subscription.</p>
            {providers.providers.map((p) => <p key={p.id} className="hint">{p.name}: {p.help}</p>)}
            <button className="save" onClick={() => void api.providers(true).then(setProviders).catch(failure)}>[check again]</button>
          </div>
        )}
        {usable.length > 0 && messages.length === 0 && (
          <div className="answer"><span className="who">OMA:</span> <p className="inline">&gt;&gt;&gt; ready. ask about this book, or try /summarize, /ideas, /quiz.</p></div>
        )}
        {messages.map((message, i) => (
          message.role === 'user'
            ? <div key={i} className="question"><span>USER_&gt;</span> {message.content}</div>
            : message.content || message.error
              ? <Answer key={i} message={message} go={go} onSave={() => void saveNote(message).catch(failure)} />
              : null
        ))}
        {busy && messages.at(-1)?.content === '' && <div className="thinking">&gt;&gt;&gt; reading<span className="cursor" /></div>}
      </div>
      {suggestions.length > 0 && (
        <div className="suggest">
          {suggestions.map((name) => (
            <button key={name} onClick={() => { setInput(name); field.current?.focus(); }}>
              <b>{name}</b> {COMMANDS[name]?.hint ?? ''}
            </button>
          ))}
        </div>
      )}
      {selection && (
        <div className="quoted"><span>"{selection.slice(0, 130)}{selection.length > 130 ? '…' : ''}"</span><button className="icon" title="Remove" onClick={() => setSelection(null)}>×</button></div>
      )}
      <form className="ask" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <span>USER_&gt;</span>
        <textarea
          ref={field}
          rows={1}
          value={input}
          placeholder="type question or /command"
          disabled={usable.length === 0}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Escape') field.current?.blur();
          }}
        />
        {busy && <button type="button" className="tab" title="Stop" onClick={() => abort.current?.abort()}>^C</button>}
      </form>
    </Pane>
  );
}
