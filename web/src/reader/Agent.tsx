import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, BookmarkPlus, MessageSquarePlus, MoreVertical, Square, X } from 'lucide-react';
import { api, ask, type AskBody } from '../api';
import { renderMarkdown } from '../markdown';
import type { Location } from '../session';
import type { BookDetail, ChatSummary, Citation, Message, Providers } from '../types';
import { failure, Pane, toast, useAsync } from '../ui';

const COMMANDS: Record<string, { question: string; label: string; scope?: 'chapter' | 'book'; hint: string }> = {
  '/summarize': { question: 'Summarize this chapter: its argument or events, and what matters most.', label: '/summarize', scope: 'chapter', hint: 'this chapter' },
  '/ideas': { question: 'What are the central ideas of this book, and how do they build on each other?', label: '/ideas', scope: 'book', hint: 'sampled book overview' },
  '/quiz': { question: 'Write five thought-provoking questions on this chapter to test my understanding. Do not give the answers yet.', label: '/quiz', scope: 'chapter', hint: 'test yourself' },
};
const LOCAL = ['/new', '/clear', '/model'];

function Answer({ message, go, onSave }: { message: Message; go: (block: number) => void; onSave: () => void }) {
  const html = useMemo(() => renderMarkdown(message.content, true), [message.content]);
  const byNumber = useMemo(() => new Map<string, Citation>(message.citations.map((c) => [String(c.n), c])), [message.citations]);
  return (
    <div className="answer">
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
      {message.error && <p className="error" role="alert">{message.error}</p>}
      {message.content && <button className="save" title="Save answer to notebook" onClick={onSave}><BookmarkPlus size={13} /> Save to notebook</button>}
    </div>
  );
}

export interface AskSeed { selection: string; block: number; endBlock: number; question?: string; nonce: number }

export function Agent({ book, location, seed, go }: { book: BookDetail; location?: Location; seed: AskSeed | null; go: (block: number) => void }) {
  const [providers, , setProviders] = useAsync<Providers>(() => api.providers(), []);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [selection, setSelection] = useState<AskSeed | null>(null);
  const [scope, setScope] = useState<AskBody['scope']>(location ? 'page' : 'search');
  const [chapter, setChapter] = useState<string>('current');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [large, setLarge] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const handled = useRef(0);
  const options = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!options.current?.contains(event.target as Node) && !menuButton.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenu(false); menuButton.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menu]);

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
      if (event.key === 'i' && !(event.target as HTMLElement).closest('input,textarea,select') && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        field.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => () => abort.current?.abort(), []);

  const send = async (question: string, options: { label?: string; scope?: AskBody['scope']; selection?: AskSeed | null } = {}) => {
    const text = question.trim();
    if (!text || busy) return;
    const quoted = options.selection !== undefined ? options.selection : selection;
    const chosenScope = options.scope ?? scope;
    const chapterId = chapter === 'current' ? book.chapters.findLast((c) => c.start <= (location?.block ?? 0))?.idx : Number(chapter);
    setInput('');
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    let appended = false;
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
      appended = true;
      const update = (change: (m: Message) => Message) => setMessages((list) => [...list.slice(0, -1), change(list[list.length - 1])]);
      await ask(id, { question: text, label: options.label, selection: chosenScope === 'selection' ? quoted?.selection : undefined, block: chosenScope === 'selection' ? quoted?.block : (chosenScope === 'page' ? location?.visibleStart ?? location?.block : location?.block), end_block: chosenScope === 'selection' ? quoted?.endBlock : location?.endBlock, page: chosenScope === 'page' && book.format === 'pdf' ? location?.page : undefined, chapter: chosenScope === 'chapter' ? chapterId : undefined, scope: chosenScope }, (event) => {
        if (event.type === 'citations') update((m) => ({ ...m, citations: event.citations }));
        if (event.type === 'delta') update((m) => ({ ...m, content: m.content + event.text }));
        if (event.type === 'error') update((m) => ({ ...m, error: event.message }));
      }, controller.signal);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        if (appended) setMessages((list) => [...list.slice(0, -1), { ...list[list.length - 1], error: (error as Error).message }]);
        else failure(error);
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const submit = () => {
    if (busy) return;
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
    if (command) { setScope(command.scope); void send(command.question, command); }
    else void send(input);
  };

  useEffect(() => {
    if (!seed || handled.current === seed.nonce) return;
    handled.current = seed.nonce;
    setSelection(seed);
    setScope('selection');
    if (seed.question) void send(seed.question, { selection: seed, scope: 'selection', label: `${seed.question} "${seed.selection.slice(0, 120)}"` });
    else {
      setSelection(seed);
      setScope('selection');
      field.current?.focus();
    }
  }, [seed]);

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
    await api.createNote({ book_id: book.id, title: question.split('\n')[0].slice(0, 90), body: cited + (message.citations.length ? '\n\nSources:\n' + message.citations.map((c) => `- [${c.chapter}${c.page ? `, p. ${c.page}` : ''}, passage ${c.block}](#/read/${book.id}?b=${c.block}): ${c.quote}`).join('\n') : '') });
    toast('saved to notebook');
  };

  const suggestions = input.startsWith('/') ? [...Object.keys(COMMANDS), ...LOCAL].filter((c) => c.startsWith(input.trim())) : [];

  return (
    <Pane
      className={`agent ${large ? 'large' : ''}`}
      title="Ask this book"
      tools={
        <>
          <button className="icon" title="New conversation" aria-label="New conversation" disabled={busy} onClick={() => { setChat(null); setMessages([]); setInput(''); field.current?.focus(); }}><MessageSquarePlus size={16} /></button>
          <button ref={menuButton} className={`icon ${menu ? 'on' : ''}`} title="Chat options" aria-label="Chat options" aria-expanded={menu} aria-controls="chat-options" onClick={() => setMenu(!menu)}><MoreVertical size={17} /></button>
        </>
      }
    >
      {menu && (
        <div ref={options} id="chat-options" className="popover provider-menu chat-options" role="dialog" aria-label="Chat options">
          <div className="chat-options-heading"><span>Chat options</span><button className="icon" aria-label="Close chat options" onClick={() => setMenu(false)}><X size={14} /></button></div>
          <button className="ghost" onClick={() => { setLarge(!large); setMenu(false); }}>{large ? 'Restore panel size' : 'Expand conversation'}</button>
          {chats.length > 0 && <label className="conversation-picker">Conversations
            <select disabled={busy} aria-label="Conversation" value={chat ?? ''} onChange={(event) => { setChat(event.target.value || null); setMenu(false); }}>
              <option value="">New conversation</option>
              {chats.map((c) => <option key={c.id} value={c.id}>{c.title || 'Untitled conversation'}</option>)}
            </select>
          </label>}
          {providers?.providers.map((p) => (
            <section key={p.id}>
              <h4>{p.name}{p.plan ? ` · ${p.plan}` : ''}</h4>
              {p.signed_in ? p.models.map((m) => (
                <button key={m.id} disabled={busy} className={p.id === providers.selected && m.id === providers.model ? 'on' : ''} onClick={() => void pick(p.id, m.id).catch(failure)}>{m.label}</button>
              )) : <p className="hint">{p.help}</p>}
            </section>
          ))}
          <button className="ghost" onClick={() => void api.providers(true).then(setProviders).catch(failure)}>Refresh providers</button>
          <p className="chat-disclosure">Your question and source excerpts go to the selected provider. Check citations against the book; answers can be wrong.</p>
        </div>
      )}
      <div className="question-scope">
        <select aria-label="Question scope" title="Choose what to ask about" disabled={busy} value={scope} onChange={(event) => setScope(event.target.value as AskBody['scope'])}>
          {location && <option value="page">{book.format === 'pdf' ? `This page · ${location.page}` : 'Visible passages'}</option>}
          {selection && <option value="selection">Selected text</option>}
          <option value="chapter">This chapter</option>
          <option value="search">Search this book</option>
          <option value="book">Book overview (sampled)</option>
        </select>
        {scope === 'chapter' && <select aria-label="Question chapter" disabled={busy} value={chapter} onChange={(event) => setChapter(event.target.value)}>
          <option value="current">{location ? 'Current chapter' : 'First chapter'}</option>
          {book.chapters.map((c) => <option key={c.idx} value={c.idx}>{c.title}</option>)}
        </select>}
      </div>
      <div className="chat-log" ref={log}>
        {providers && usable.length === 0 && (
          <div className="chat-empty"><p>Connect a provider to ask about your book.</p><button className="ghost" onClick={() => setMenu(true)}>Choose a provider</button></div>
        )}
        {usable.length > 0 && messages.length === 0 && (
          <div className="chat-empty"><p>What would you like to understand?</p><span>A passage, a chapter, or a question worth following.</span></div>
        )}
        {messages.map((message, i) => (
          message.role === 'user'
            ? <div key={i} className="question" aria-label="Your question">{message.content}</div>
            : message.content || message.error
              ? <Answer key={i} message={message} go={go} onSave={() => void saveNote(message).catch(failure)} />
              : null
        ))}
        {busy && messages.at(-1)?.content === '' && <div className="thinking" role="status">Reading the passages…</div>}
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
      {selection && scope === 'selection' && (
        <div className="quoted"><span title={selection.selection}>“{selection.selection.slice(0, 130)}{selection.selection.length > 130 ? '…' : ''}”</span><button className="icon" title="Remove selected text" aria-label="Remove selected text" onClick={() => { setSelection(null); if (scope === 'selection') setScope(location ? 'page' : 'search'); }}><X size={14} /></button></div>
      )}
      <form className="ask" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          ref={field}
          rows={2}
          aria-label="Ask about your book"
          value={input}
          placeholder="Ask about what you’re reading…"
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
        {!busy && <button type="submit" className="chat-send" title="Send question" aria-label="Send question" disabled={!input.trim() || usable.length === 0}><ArrowUp size={18} /></button>}
        {busy && <button type="button" className="chat-send" title="Stop response" aria-label="Stop response" onClick={() => abort.current?.abort()}><Square size={14} /></button>}
      </form>
    </Pane>
  );
}
