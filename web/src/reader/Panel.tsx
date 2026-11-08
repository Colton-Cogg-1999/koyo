import type { ReactNode } from 'react';
import { Highlighter, NotebookText, Sparkle, X } from 'lucide-react';

export type Tab = 'ask' | 'notes' | 'highlights';

const TABS: { id: Tab; label: string; icon: ReactNode; key: string }[] = [
  { id: 'ask', label: 'Ask', icon: <Sparkle size={16} />, key: 'q' },
  { id: 'notes', label: 'Notes', icon: <NotebookText size={16} />, key: 'n' },
  { id: 'highlights', label: 'Highlights', icon: <Highlighter size={16} />, key: 'h' },
];

export function Tabs({ tab, onTab, onClose }: { tab: Tab; onTab: (tab: Tab) => void; onClose: () => void }) {
  return (
    <header className="panel-head tabs">
      <div role="tablist" aria-label="Reading companion">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} title={`${t.label} (${t.key})`} onClick={() => onTab(t.id)}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>
      <span className="grow" />
      <button className="icon" title="Close (Esc)" aria-label="Close panel" onClick={onClose}><X size={17} /></button>
    </header>
  );
}

export function PanelHeader({ title, children, onClose }: { title: ReactNode; children?: ReactNode; onClose: () => void }) {
  return (
    <header className="panel-head">
      <h2>{title}</h2>
      <span className="grow" />
      {children}
      <button className="icon" title="Close (Esc)" aria-label="Close panel" onClick={onClose}><X size={17} /></button>
    </header>
  );
}
