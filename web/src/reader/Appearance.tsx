import { Minus, Plus } from 'lucide-react';
import { api } from '../api';
import { failure, useAsync } from '../ui';
import { setTheme, useTheme, type ThemeMode } from '../theme';
import type { ReaderPrefs } from '../types';

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'night', label: 'Night' },
  { id: 'auto', label: 'Auto' },
];
const FONTS: { id: ReaderPrefs['font']; label: string }[] = [
  { id: 'serif', label: 'Literata' },
  { id: 'mincho', label: 'Mincho' },
  { id: 'sans', label: 'Sans' },
];

function Stepper({ label, value, onLess, onMore }: { label: string; value: string; onLess: () => void; onMore: () => void }) {
  return (
    <div className="stepper">
      <span>{label}</span>
      <button className="icon" aria-label={`Less ${label.toLowerCase()}`} onClick={onLess}><Minus size={14} /></button>
      <output>{value}</output>
      <button className="icon" aria-label={`More ${label.toLowerCase()}`} onClick={onMore}><Plus size={14} /></button>
    </div>
  );
}

export function Appearance({ prefs, pdf, onChange }: { prefs: ReaderPrefs; pdf: boolean; onChange: (patch: Partial<ReaderPrefs>) => void }) {
  const { mode } = useTheme();
  const [providers, , setProviders] = useAsync(() => api.providers(), []);
  const choices = providers?.providers.filter((p) => p.signed_in) ?? [];
  const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, Math.round(n * 100) / 100));
  return (
    <div className="popover appearance" role="dialog" aria-label="Reading appearance">
      <div className="segmented" role="group" aria-label="Theme">
        {THEMES.map((t) => <button key={t.id} className={mode === t.id ? 'on' : ''} aria-pressed={mode === t.id} onClick={() => setTheme(t.id)}>{t.label}</button>)}
      </div>
      {pdf ? (
        <Stepper label="Zoom" value={`${Math.round(prefs.zoom * 100)}%`} onLess={() => onChange({ zoom: clamp(prefs.zoom - 0.1, 0.6, 2.5) })} onMore={() => onChange({ zoom: clamp(prefs.zoom + 0.1, 0.6, 2.5) })} />
      ) : (
        <>
          <div className="segmented fonts" role="group" aria-label="Typeface">
            {FONTS.map((f) => <button key={f.id} className={`font-${f.id} ${prefs.font === f.id ? 'on' : ''}`} aria-pressed={prefs.font === f.id} onClick={() => onChange({ font: f.id })}>{f.label}</button>)}
          </div>
          <Stepper label="Size" value={`${prefs.size}`} onLess={() => onChange({ size: Math.max(14, prefs.size - 1) })} onMore={() => onChange({ size: Math.min(32, prefs.size + 1) })} />
          <Stepper label="Width" value={`${prefs.width}`} onLess={() => onChange({ width: Math.max(26, prefs.width - 2) })} onMore={() => onChange({ width: Math.min(48, prefs.width + 2) })} />
        </>
      )}
      {choices.length > 0 && providers && (
        <label className="stepper model">
          <span>Answers</span>
          <select aria-label="Model" value={`${providers.selected}:${providers.model}`} onChange={(e) => {
            const [provider, ...rest] = e.target.value.split(':');
            const model = rest.join(':');
            void api.saveSettings({ ai_provider: provider, ai_model: model }).then(() => setProviders({ ...providers, selected: provider, model })).catch(failure);
          }}>
            {choices.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.models.map((m) => <option key={m.id || 'default'} value={`${p.id}:${m.id}`}>{p.name} · {m.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
