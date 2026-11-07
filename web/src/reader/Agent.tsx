import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, BookmarkPlus, MessageSquarePlus, MoreVertical, Square, X } from 'lucide-react';
import { api, ask, type AskBody } from '../api';
import { navigate } from '../route';
import { stored, saveLocal } from '../preferences';
import { renderMarkdown } from '../markdown';
import type { Location } from '../session';
import type { BookDetail, ChatSummary, Citation, Message, Providers } from '../types';
import { failure, Pane, toast, useAsync } from '../ui';

const COMMANDS: Record<string, { question: string; label: string; scope?: 'chapter' | 'book'; hint: string }> = {
  '/summarize': { question: 'Summarize this chapter: its argument or events, and what matters most.', label: '/summarize', scope: 'chapter', hint: 'this chapter' },
  '/ideas': { question: 'What are the central ideas of this book, and how do they build on each other?', label: '/ideas', scope: 'chapter', hint: 'this chapter' },
  '/quiz': { question: 'Write five thought-provoking questions on this chapter to test my understanding. Do not give the answers yet.', label: '/quiz', scope: 'chapter', hint: 'test yourself' },
};

function Answer({ message, go, onSave }: { message: Message; go: (block: number) => void; onSave: () => void }) {
  const html = useMemo(() => renderMarkdown(message.content, message.citations.map((c) => c.n)), [message.content, message.citations]);
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
        onFocus={(event) => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cite]'); const citation = target && byNumber.get(target.dataset.cite!); if (target && citation) target.title = `${citation.chapter}: ${citation.quote}`; }}
        onMouseOver={(event) => {
          const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cite]');
          const citation = target && byNumber.get(target.dataset.cite!);
          if (target && citation) target.title = `${citation.chapter}: ${citation.quote}`;
        }}
      />
      {message.error && <p className="error" role="alert">{message.error}</p>}
      {message.context?.partial && <p className="context-note">Based on retrieved excerpts; coverage is partial.</p>}
      {message.content && <button className="save" title="Save answer to Marks" onClick={onSave}><BookmarkPlus size={13} /> Save to Marks</button>}
    </div>
  );
}

export interface AskSeed { selection: string; block: number; endBlock: number; question?: string; nonce: number }

export function Agent({ book, location, seed, go, onSelectionClear }: { onSelectionClear?: () => void; book: BookDetail; location?: Location; seed: AskSeed | null; go: (block: number) => void }) {
  const [providers] = useAsync<Providers>(() => api.providers(), []);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft] = useState(() => stored<{ input?: string; selection?: AskSeed; scope?: AskBody['scope']; chapter?: string }>(`chat-draft:${book.id}`, {}));
  const [input, setInput] = useState(draft.input ?? '');
  const [selection, setSelection] = useState<AskSeed | null>(draft.selection ?? null);
  const [scope, setScope] = useState<AskBody['scope']>(draft.scope ?? (location ? 'chapter' : 'search'));
  const [chapter, setChapter] = useState<string>(draft.chapter ?? 'current');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (field.current) { field.current.style.height = 'auto'; field.current.style.height = `${Math.min(140, Math.max(32, field.current.scrollHeight))}px`; } }, [input]);
  const handled = useRef(0);
  const follow = useRef(true);
  const [needsProvider, setNeedsProvider] = useState(false);
  const [retry, setRetry] = useState<AskBody | null>(null);
  useEffect(() => saveLocal(`chat-draft:${book.id}`, { input, selection, scope, chapter }), [book.id, input, selection, scope, chapter]);
  useEffect(() => {
    const focus = (event: Event) => { if ((event as CustomEvent).detail === 'focus-chat') window.setTimeout(() => field.current?.focus(), 0); };
    window.addEventListener('oma-reader-command', focus);
    return () => window.removeEventListener('oma-reader-command', focus);
  }, []);
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
    let live = true;
    if (chat && !busy) api.messages(chat).then((list) => live && setMessages(list)).catch(failure);
    if (!chat) setMessages([]);
    return () => { live = false; };
  }, [chat]);

  useEffect(() => {
    if (follow.current) log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'instant' });
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

  const send = async (question: string, options: { label?: string; scope?: AskBody['scope']; selection?: AskSeed | null; snapshot?: AskBody } = {}) => {
    const text = question.trim();
    if (!text || busy) return;
    if (!providers?.providers.some((p) => p.signed_in)) { setNeedsProvider(true); return; }
    const quoted = options.selection !== undefined ? options.selection : selection;
    const chosenScope = options.scope ?? scope;
    if (chosenScope === 'selection' && !quoted && !options.snapshot) return;
    const chapterId = chapter === 'current' ? book.chapters.findLast((c) => c.start <= (location?.block ?? 0))?.idx : Number(chapter);
    const snapshot: AskBody = options.snapshot ?? {
      question: text, label: options.label, scope: chosenScope,
      selection: chosenScope === 'selection' ? quoted?.selection : undefined,
      attachment: chosenScope !== 'selection' && quoted ? { text: quoted.selection, block: quoted.block, end_block: quoted.endBlock } : undefined,
      block: chosenScope === 'selection' ? quoted?.block : chosenScope === 'page' ? location?.visibleStart ?? location?.block : location?.block,
      end_block: chosenScope === 'selection' ? quoted?.endBlock : location?.endBlock,
      page: chosenScope === 'page' && book.format === 'pdf' ? location?.page : undefined,
      chapter: chosenScope === 'chapter' ? chapterId : undefined,
    };
    setInput('');
    setSelection(null); onSelectionClear?.();
    if (scope === 'selection') setScope(location ? 'chapter' : 'search');
    follow.current = true;
    setRetry(null);
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
      const user: Message = { role: 'user', content: options.label ?? text, citations: [], context: snapshot };
      setMessages((list) => [...list, user, { role: 'assistant', content: '', citations: [] }]);
      appended = true;
      const update = (change: (m: Message) => Message) => setMessages((list) => [...list.slice(0, -1), change(list[list.length - 1])]);
      await ask(id, snapshot, (event) => {
        if (event.type === 'context') update((m) => ({ ...m, context: event.context }));
        if (event.type === 'citations') update((m) => ({ ...m, citations: event.citations }));
        if (event.type === 'delta') update((m) => ({ ...m, content: m.content + event.text }));
        if (event.type === 'error') { update((m) => ({ ...m, error: 'The request couldn’t be completed.' })); setRetry(snapshot); }
      }, controller.signal);
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setRetry(snapshot);
        if (appended) setMessages((list) => [...list.slice(0, -1), { ...list[list.length - 1], error: 'The connection was interrupted.' }]);
        else failure(new Error('The request couldn’t be completed.'));
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
    {
        field.current?.focus();
    }
  }, [seed]);

  const usable = providers?.providers.filter((p) => p.signed_in) ?? [];

  const saveNote = async (message: Message) => {
    const question = messages[messages.indexOf(message) - 1]?.content ?? 'From Oma';
    const cited = message.content.replace(/\[(\d{1,3})\]/g, (whole, n) => {
      const citation = message.citations.find((c) => String(c.n) === n);
      return citation ? ` (${citation.chapter}${citation.page ? `, p. ${citation.page}` : ''})` : whole;
    });
    const source = message.citations[0];
    if (!source) return toast('This answer has no source location to save.', 'error');
    await api.createAnnotation({ book_id: book.id, kind: 'highlight', color: 'green', block: source.block, page: source.page, anchor: { kind: 'bookmark', block: source.block, page: source.page }, quote: source.quote, note: `${question}\n\n${cited}\n\nSources:\n` + message.citations.map((c) => `- ${c.chapter}${c.page ? `, p. ${c.page}` : ''}, location ${c.block + 1}: ${c.quote}`).join('\n') });
    window.dispatchEvent(new Event('oma-annotations-changed'));
    toast('Saved to Marks');
  };


  return (
    <Pane
      className="agent"
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
          {chats.length > 0 && <label className="conversation-picker">Conversations
            <select disabled={busy} aria-label="Conversation" value={chat ?? ''} onChange={(event) => { setChat(event.target.value || null); setMenu(false); }}>
              <option value="">New conversation</option>
              {chats.map((c) => <option key={c.id} value={c.id}>{c.title || 'Untitled conversation'}</option>)}
            </select>
          </label>}
          <button className="ghost" onClick={() => navigate('settings')}>Provider and model · Settings</button>
          <button className="ghost" onClick={() => void navigator.clipboard.writeText(messages.map((m) => `${m.role === 'user' ? 'Question' : 'Answer'}\n${m.content}`).join('\n\n')).then(() => toast('Conversation copied')).catch(failure)}>Copy conversation</button>
          <button className="ghost danger" disabled={!chat || busy} onClick={() => {
            if (!chat || !window.confirm('Delete this conversation? Your book and annotations will stay.')) return;
            void api.deleteChat(chat).then(() => { setChats((list) => list.filter((c) => c.id !== chat)); setChat(null); setMessages([]); }).catch(failure);
          }}>Delete conversation</button>
          <p className="chat-disclosure">Your question and source excerpts go to the selected provider. Check citations against the book; answers can be wrong.</p>
        </div>
      )}
      <div className="question-scope">
        <select aria-label="Question scope" title="Choose what to ask about" disabled={busy} value={scope === 'chapter' && chapter !== 'current' ? `chapter:${chapter}` : scope} onChange={(event) => {
          const value = event.target.value;
          if (value.startsWith('chapter:')) { setScope('chapter'); setChapter(value.slice(8)); }
          else { setScope(value as AskBody['scope']); if (value === 'chapter') setChapter('current'); }
        }}>
          {location && <option value="page">{book.format === 'pdf' ? `This page · ${location.page}` : 'Visible passages'}</option>}
          <option value="selection" disabled={!selection}>Selected text</option>
          <option value="chapter">This chapter</option>
          <option value="search">This book</option>
          <optgroup label="A specific chapter">{book.chapters.map((c) => <option key={c.idx} value={`chapter:${c.idx}`}>{c.title}</option>)}</optgroup>
        </select>

      </div>
      <div className="chat-log" ref={log} onScroll={() => { const box = log.current; if (box) follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48; }}>
        {needsProvider && usable.length === 0 && (
          <div className="chat-empty"><p>Choose an AI provider to ask questions.</p><button className="ghost" onClick={() => navigate('settings')}>Configure</button></div>
        )}
        {usable.length > 0 && messages.length === 0 && (
          <div className="chat-empty"><p>Ask a question about this chapter.</p></div>
        )}
        {messages.map((message, i) => (
          message.role === 'user'
            ? <div key={i} className="question" aria-label="Your question">{message.content}{(message.context?.attachment?.text || message.context?.selection) && <blockquote className="question-attachment" title={message.context.attachment?.text ?? message.context.selection}>{(message.context.attachment?.text ?? message.context.selection)?.slice(0, 160)}</blockquote>}</div>
            : message.content || message.error
              ? <Answer key={i} message={message} go={go} onSave={() => void saveNote(message).catch(failure)} />
              : null
        ))}
        {busy && messages.at(-1)?.content === '' && <div className="thinking" role="status">Reading the passages…</div>}
      </div>
      {retry && !busy && <button className="retry-question ghost" onClick={() => void send(retry.question, { snapshot: retry })}>Retry question</button>}
      {selection && (
        <div className="quoted"><span title={selection.selection}>“{selection.selection.slice(0, 130)}{selection.selection.length > 130 ? '…' : ''}”</span><button className="icon" title="Remove selected text" aria-label="Remove selected text" onClick={() => { setSelection(null); onSelectionClear?.(); if (scope === 'selection') setScope(location ? 'chapter' : 'search'); }}><X size={14} /></button></div>
      )}
      <form className="ask" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          ref={field}
          rows={2}
          aria-label="Ask about your book"
          value={input}
          placeholder="Ask about what you’re reading…"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Escape') { if (selection) { setSelection(null); onSelectionClear?.(); if (scope === 'selection') setScope(location ? 'chapter' : 'search'); } else field.current?.blur(); }
          }}
        />
        {!busy && <button type="submit" className="chat-send" title="Send question" aria-label="Send question" disabled={!input.trim()}><ArrowUp size={18} /></button>}
        {busy && <button type="button" className="chat-send" title="Stop response" aria-label="Stop response" onClick={() => abort.current?.abort()}><Square size={14} /></button>}
      </form>
    </Pane>
  );
}
