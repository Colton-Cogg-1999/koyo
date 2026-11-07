import { useEffect, useRef, useState } from 'react';
import { readerCommand } from './preferences';
import { navigate } from './route';

export function CommandPalette({ reading, onClose, onSearch, onImport }: { reading: boolean; onClose: () => void; onSearch: () => void; onImport: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const previous = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => () => previous.current?.focus(), []);
  const commands = [
    { name: 'Open Library', key: 'Ctrl+L', run: () => navigate('library') },
    { name: 'Import books', key: '', run: onImport },
    { name: reading ? 'Search in book' : 'Search books', key: 'Ctrl+F', run: onSearch },
    { name: 'Open Marks', key: '', run: () => navigate('annotations') },
    { name: 'Appearance and settings', key: '', run: () => navigate('settings') },
    ...(reading ? [
      { name: 'Add or remove bookmark', key: 'Ctrl+D', run: () => readerCommand('bookmark') },
      { name: 'Toggle notes', key: '', run: () => readerCommand('toggle-notes') },
      { name: 'Toggle chat', key: '', run: () => readerCommand('toggle-chat') },
      { name: 'Ask about selection', key: '', run: () => readerCommand('ask-selection') },
      { name: 'Focus question input', key: 'Ctrl+J', run: () => readerCommand('focus-chat') },
      { name: 'Go to chapter', key: '', run: () => readerCommand('chapters') },
      { name: 'Reading appearance', key: '', run: () => readerCommand('appearance') },
    ] : []),
  ].filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  const execute = (i: number) => { const command = commands[i]; if (command) { onClose(); window.setTimeout(command.run, 0); } };
  return <div className="search-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0,Math.min(commands.length-1,i+(e.key === 'ArrowDown' ? 1 : -1)))); }
      if (e.key === 'Enter') { e.preventDefault(); execute(index); }
      if (e.key === 'Tab') { e.preventDefault(); }
    }}>
      <input autoFocus role="combobox" aria-label="Find a command" aria-expanded="true" aria-controls="command-list" aria-activedescendant={commands[index] ? `command-${index}` : undefined} placeholder="Find a command…" value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} />
      <div id="command-list" role="listbox">{commands.map((c,i) => <button role="option" id={`command-${i}`} aria-selected={i === index} tabIndex={-1} key={c.name} onMouseEnter={() => setIndex(i)} onClick={() => execute(i)}>{c.name}<kbd>{c.key}</kbd></button>)}</div>
      {!commands.length && <p className="hint">No matching commands.</p>}
    </div>
  </div>;
}
