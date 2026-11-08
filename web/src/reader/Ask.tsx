import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, BookmarkPlus, BookOpen, MessageSquarePlus, RefreshCw, Square, X } from 'lucide-react';
import { api, ask, type AskBody } from '../api';
import { renderMarkdown } from '../markdown';
import { saveLocal, stored } from '../preferences';
import type { BookDetail, Citation, Message, Providers, ReadingLocation } from '../types';
import { failure, Sun, toast } from '../ui';

export interface AskSeed { selection: string; block: number; endBlock: number; nonce: number }
type Scope = 'page' | 'selection' | 'chapter' | 'search';

const SUGGESTIONS = [
  { label: 'Summarize this chapter', question: 'Summarize this chapter: its argument or events, and what matters most.' },
  { label: 'What is the key idea here?', question: 'What is the central idea of this chapter, and how is it supported?', scope: 'chapter' as Scope },
  { label: 'Quiz me', question: 'Write five thought-provoking questions on this chapter to test my understanding. Do not give the answers yet.' },
];

function Answer({ message, go, onSave }: { message: Message; go: (block: number) => void; onSave: () => void }) {
  const html = useMemo(() => renderMarkdown(message.content, message.citations.map((c) => c.n)), [message.content, message.citations]);
  const byNumber = useMemo(() => new Map<string, Citation>(message.citations.map((c) => [String(c.n), c])), [message.citations]);
  const describe = (event: React.SyntheticEvent) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-cite]');
    const citation = target && byNumber.get(target.dataset.cite!);
    if (target && citation) target.title = `${citation.chapter}: ${citation.quote}`;
  };
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
        onMouseOver={describe}
        onFocus={describe}
      />
      {message.error && <p className="error" role="alert">{message.error}</p>}
      {message.context?.partial && <p className="hint">Based on retrieved excerpts; coverage is partial.</p>}
      {message.content && message.citations.length > 0 && <button className="ghost small" title="Keep this answer in your notes" onClick={onSave}><BookmarkPlus size={13} /> Save to notes</button>}
    </div>
  );
}

export function Ask({ book, location, seed, go, onSaved }: {
  book: BookDetail;
  location: ReadingLocation;
  seed: AskSeed | null;
  go: (block: number) => void;
  onSaved: () => void;
}) {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [checking, setChecking] = useState(false);
  const [chat, setChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft] = useState(() => stored<{ input?: string; selection?: AskSeed; scope?: Scope }>(`ask-draft:${book.id}`, {}));
  const [input, setInput] = useState(draft.input ?? '');
  const [selection, setSelection] = useState<AskSeed | null>(draft.selection ?? null);
  const [scope, setScope] = useState<Scope>(draft.scope ?? (draft.selection ? 'selection' : 'chapter'));
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<AskBody | null>(null);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const handled = useRef(0);

  const check = (refresh = false) => {
    setChecking(true);
    return api.providers(refresh).then(setProviders).catch(failure).finally(() => setChecking(false));
  };
  useEffect(() => { void check(); }, []);
  useEffect(() => saveLocal(`ask-draft:${book.id}`, { input, selection, scope }), [book.id, input, selection, scope]);
  useEffect(() => { if (field.current) { field.current.style.height = 'auto'; field.current.style.height = `${Math.min(160, field.current.scrollHeight)}px`; } }, [input]);
  useEffect(() => {
    api.chats(book.id).then((list) => list[0] && setChat(list[0].id)).catch(failure);
  }, [book.id]);
  useEffect(() => {
    let live = true;
    if (chat && !busy) api.messages(chat).then((list) => live && setMessages(list)).catch(failure);
    return () => { live = false; };
  }, [chat]);
  useEffect(() => {
    if (follow.current) log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const focus = () => field.current?.focus();
    window.addEventListener('koyo-focus-ask', focus);
    return () => window.removeEventListener('koyo-focus-ask', focus);
  }, []);
  useEffect(() => {
    if (!seed || handled.current === seed.nonce) return;
    handled.current = seed.nonce;
    setSelection(seed);
    setScope('selection');
    field.current?.focus();
  }, [seed]);

  const ready = providers?.providers.some((p) => p.signed_in) ?? false;

  const clearSelection = () => {
    setSelection(null);
    if (scope === 'selection') setScope('chapter');
  };

  const send = async (question: string, options: { label?: string; scope?: Scope; snapshot?: AskBody } = {}) => {
    const text = question.trim();
    if (!text || busy || !ready) return;
    const chosen = options.scope ?? scope;
    if (chosen === 'selection' && !selection && !options.snapshot) return;
    const snapshot: AskBody = options.snapshot ?? {
      question: text,
      label: options.label,
      scope: chosen,
      selection: chosen === 'selection' ? selection?.selection : undefined,
      attachment: chosen !== 'selection' && selection ? { text: selection.selection, block: selection.block, end_block: selection.endBlock } : undefined,
      block: chosen === 'selection' ? selection?.block : chosen === 'page' ? location.visibleStart ?? location.block : location.block,
      end_block: chosen === 'selection' ? selection?.endBlock : location.endBlock,
      page: chosen === 'page' && book.format === 'pdf' ? location.page : undefined,
      chapter: chosen === 'chapter' ? book.chapters.findLast((c) => c.start <= location.block)?.idx : undefined,
    };
    setInput('');
    setSelection(null);
    if (scope === 'selection') setScope('chapter');
    follow.current = true;
    setRetry(null);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    let appended = false;
    try {
      let id = chat;
      if (!id) {
        id = (await api.createChat(book.id)).id;
        setChat(id);
      }
      setMessages((list) => [...list, { role: 'user', content: options.label ?? text, citations: [], context: snapshot }, { role: 'assistant', content: '', citations: [] }]);
      appended = true;
      const update = (change: (m: Message) => Message) => setMessages((list) => [...list.slice(0, -1), change(list[list.length - 1])]);
      await ask(id, snapshot, (event) => {
        if (event.type === 'context') update((m) => ({ ...m, context: event.context }));
        if (event.type === 'citations') update((m) => ({ ...m, citations: event.citations }));
        if (event.type === 'delta') update((m) => ({ ...m, content: m.content + event.text }));
        if (event.type === 'error') { update((m) => ({ ...m, error: event.message || 'The request couldn’t be completed.' })); setRetry(snapshot); }
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

  const saveAnswer = async (message: Message) => {
    const question = messages[messages.indexOf(message) - 1]?.content ?? 'Question';
    const source = message.citations[0];
    if (!source) return;
    const cited = message.content.replace(/\[(\d{1,3})\]/g, (whole, n) => {
      const citation = message.citations.find((c) => String(c.n) === n);
      return citation ? ` (${citation.chapter}${citation.page ? `, p. ${citation.page}` : ''})` : whole;
    });
    const sources = message.citations.map((c) => `- ${c.chapter}${c.page ? `, p. ${c.page}` : ''}, location ${c.block + 1}: ${c.quote}`).join('\n');
    await api.createAnnotation({
      book_id: book.id, kind: 'highlight', color: 'blue', block: source.block, page: source.page,
      anchor: { kind: 'bookmark', block: source.block, page: source.page }, quote: source.quote,
      note: `${question}\n\n${cited}\n\nSources:\n${sources}`,
    });
    onSaved();
    toast('Saved to notes');
  };


  return (
    <>
      <div className="panel-scroll chat" ref={log} onScroll={() => { const box = log.current; if (box) follow.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48; }}>
        {!providers && <div className="thinking" role="status"><Sun size={8} /> Looking for your AI tools…</div>}
        {providers && !ready && (
          <div className="setup">
            <p>Answers come from an AI command-line tool you already use. Sign in to one, then check again.</p>
            {providers.providers.map((p) => (
              <div key={p.id} className="setup-provider">
                <strong>{p.name}</strong>
                <span>{p.installed ? 'Not signed in' : 'Not installed'}</span>
                <p className="hint">{p.help}</p>
              </div>
            ))}
            <button className="ghost" disabled={checking} onClick={() => void check(true)}><RefreshCw size={13} /> {checking ? 'Checking…' : 'Check again'}</button>
          </div>
        )}
        {ready && messages.length === 0 && (
          <div className="panel-empty">
            <p>Ask anything about what you’re reading. Answers cite the passages they rely on.</p>
            <p className="hint">Your question and the quoted passages go to {providers?.providers.find((p) => p.id === providers.selected)?.name ?? 'your AI tool'}. Check answers against the page.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s.label} className="ghost" disabled={busy} onClick={() => void send(s.question, { label: s.label, scope: s.scope ?? 'chapter' })}>{s.label}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message, i) => (
          message.role === 'user'
            ? <div key={i} className="question">
                {(message.context?.attachment?.text || message.context?.selection) && <blockquote>{(message.context.attachment?.text ?? message.context.selection)!.slice(0, 220)}</blockquote>}
                {message.content}
              </div>
            : message.content || message.error
              ? <Answer key={i} message={message} go={go} onSave={() => void saveAnswer(message).catch(failure)} />
              : null
        ))}
        {busy && messages.at(-1)?.content === '' && <div className="thinking" role="status"><Sun size={8} /> Reading the passages…</div>}
        {retry && !busy && <button className="ghost small" onClick={() => void send(retry.question, { snapshot: retry })}><RefreshCw size={13} /> Try again</button>}
      </div>

      <form className="ask-form" onSubmit={(event) => { event.preventDefault(); void send(input); }}>
        {selection && (
          <div className="attached">
            <span title={selection.selection}>“{selection.selection.slice(0, 160)}{selection.selection.length > 160 ? '…' : ''}”</span>
            <button type="button" className="icon" aria-label="Remove passage" onClick={clearSelection}><X size={13} /></button>
          </div>
        )}
        <div className="ask-input">
          <textarea
            ref={field}
            rows={1}
            aria-label="Ask about your book"
            value={input}
            disabled={!ready}
            placeholder={selection ? 'Ask about this passage…' : 'Ask a question…'}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(input); }
              if (event.key === 'Escape') { event.stopPropagation(); if (selection) clearSelection(); else field.current?.blur(); }
            }}
          />
          {busy
            ? <button type="button" className="send" title="Stop" aria-label="Stop response" onClick={() => abort.current?.abort()}><Square size={12} /></button>
            : <button type="submit" className="send" title="Ask (Enter)" aria-label="Send question" disabled={!input.trim() || !ready}><ArrowUp size={16} /></button>}
        </div>
        <div className="ask-options">
          <BookOpen size={16} aria-hidden="true" />
          <select className="scope" aria-label="Question scope" value={scope} disabled={busy} onChange={(e) => setScope(e.target.value as Scope)}>
            {selection && <option value="selection">From the passage</option>}
            <option value="page">{book.format === 'pdf' ? `From page ${location.page}` : 'From what’s on screen'}</option>
            <option value="chapter">From this chapter</option>
            <option value="search">From the whole book</option>
          </select>
          {messages.length > 0 && <button type="button" className="icon" title="New conversation" aria-label="New conversation" disabled={busy} onClick={() => { setChat(null); setMessages([]); setRetry(null); field.current?.focus(); }}><MessageSquarePlus size={16} /></button>}
        </div>
      </form>
    </>
  );
}
