import { useEffect, useRef, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useLocalPreference } from '../preferences';

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, Number.isFinite(n) ? n : low));

/** Layout preferences are separate from book content; both panels stay mounted when collapsed. */
export function ReaderSidebar({ notes, chat, open, onClose }: { notes: ReactNode; chat: ReactNode; open: boolean; onClose: () => void }) {
  const [width, setWidth] = useLocalPreference('sidebar-width', 28);
  const [split, setSplit] = useLocalPreference('sidebar-split', 34);
  const [notesOpen, setNotesOpen] = useLocalPreference('notes-open', true);
  const [chatOpen, setChatOpen] = useLocalPreference('chat-open', true);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const command = (event: Event) => {
      const name = (event as CustomEvent<string>).detail;
      if (name === 'toggle-notes') setNotesOpen((v) => !v);
      if (name === 'toggle-chat') setChatOpen((v) => !v);
      if (name === 'focus-chat' || name === 'ask-selection') setChatOpen(true);
    };
    window.addEventListener('oma-reader-command', command);
    return () => window.removeEventListener('oma-reader-command', command);
  }, []);
  const drag = (event: React.PointerEvent, horizontal: boolean) => {
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const rect = box.current?.getBoundingClientRect();
      const parent = box.current?.parentElement?.getBoundingClientRect();
      if (!rect || !parent) return;
      if (horizontal) setWidth(clamp((parent.right - e.clientX) / parent.width * 100, 23, 45));
      else setSplit(clamp((e.clientY - rect.top) / rect.height * 100, 20, 70));
    };
    const finish = () => { target.removeEventListener('pointermove', move as EventListener); target.removeEventListener('pointerup', finish); target.removeEventListener('pointercancel', finish); };
    target.addEventListener('pointermove', move as EventListener);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', finish);
  };
  return <>
    {open && <div className="reader-divider" role="separator" aria-label="Sidebar width" aria-orientation="vertical" aria-valuemin={23} aria-valuemax={45} aria-valuenow={Math.round(clamp(width, 23, 45))} tabIndex={0} onPointerDown={(e) => drag(e, true)} onKeyDown={(e) => { if (['ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); setWidth(clamp(width + (e.key === 'ArrowLeft' ? 1 : -1),23,45)); } }} />}
    <div ref={box} className="side" hidden={!open} style={{ width: `${clamp(width,23,45)}%` }}>
      <button className="side-close ghost" onClick={onClose}>Back to reading</button>
      <section className={`sidebar-region notes-region ${notesOpen ? '' : 'collapsed'}`} style={{ flex: notesOpen ? chatOpen ? `1 1 ${clamp(split,20,70)}%` : '1 1 100%' : '0 0 auto' }}>
        <button className="collapse-panel icon" aria-label={notesOpen ? 'Collapse notes' : 'Expand notes'} aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>{notesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        {notes}
      </section>
      {notesOpen && chatOpen && <div className="panel-divider" role="separator" aria-label="Notes and chat split" aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={70} aria-valuenow={Math.round(clamp(split,20,70))} tabIndex={0} onPointerDown={(e) => drag(e,false)} onKeyDown={(e) => { if (['ArrowUp','ArrowDown'].includes(e.key)) { e.preventDefault(); setSplit(clamp(split + (e.key === 'ArrowDown' ? 2 : -2),20,70)); } }} />}
      <section className={`sidebar-region chat-region ${chatOpen ? '' : 'collapsed'}`} style={{ flex: chatOpen ? notesOpen ? `1 1 ${100-clamp(split,20,70)}%` : '1 1 100%' : '0 0 auto' }}>
        <button className="collapse-panel icon" aria-label={chatOpen ? 'Collapse chat' : 'Expand chat'} aria-expanded={chatOpen} onClick={() => setChatOpen(!chatOpen)}>{chatOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
        {chat}
      </section>
    </div>
  </>;
}
