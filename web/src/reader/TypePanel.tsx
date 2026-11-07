import { X } from 'lucide-react';
import type { ReaderPrefs } from '../types';
const PAPERS: ReaderPrefs['paper'][] = ['term', 'ivory', 'sepia'];
const FONTS: { id: ReaderPrefs['font']; label: string }[] = [
  { id: 'mono', label: 'JetBrains' },
  { id: 'newsreader', label: 'Newsreader' },
  { id: 'literata', label: 'Literata' },
  { id: 'sans', label: 'Sans' },
];

export function TypePanel({ prefs, pdf, onChange, onClose }: { prefs: ReaderPrefs; pdf: boolean; onChange: (patch: Partial<ReaderPrefs>) => void; onClose: () => void }) {
  return (
    <aside className="type-panel">
      <header>
        <h3>Reading appearance</h3>
        <button className="icon" onClick={onClose} title="Close"><X size={15} /></button>
      </header>
      <div className="choices">
        {PAPERS.map((paper) => (
          <button key={paper} className={prefs.paper === paper ? 'on' : ''} onClick={() => onChange({ paper })}>{paper}</button>
        ))}
      </div>
      {pdf ? (
        <label>zoom <output>{Math.round(prefs.zoom * 100)}%</output>
          <input type="range" min={0.6} max={2.5} step={0.05} value={prefs.zoom} onChange={(event) => onChange({ zoom: Number(event.target.value) })} />
        </label>
      ) : (
        <>
          <div className="choices two">
            {FONTS.map((font) => (
              <button key={font.id} className={`font-${font.id} ${prefs.font === font.id ? 'on' : ''}`} onClick={() => onChange({ font: font.id })}>{font.label}</button>
            ))}
          </div>
          <label>size <output>{prefs.size}px</output>
            <input type="range" min={13} max={40} value={prefs.size} onChange={(event) => onChange({ size: Number(event.target.value) })} />
          </label>
          <label>leading <output>{prefs.leading.toFixed(2)}</output>
            <input type="range" min={1.3} max={2} step={0.02} value={prefs.leading} onChange={(event) => onChange({ leading: Number(event.target.value) })} />
          </label>
          <label>measure <output>{prefs.width}em</output>
            <input type="range" min={28} max={60} value={prefs.width} onChange={(event) => onChange({ width: Number(event.target.value) })} />
          </label>
        </>
      )}
    </aside>
  );
}

