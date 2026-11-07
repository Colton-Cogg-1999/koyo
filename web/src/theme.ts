import { api, onServerEvent } from './api';

/** Which Omarchy colour drives each UI variable when following the system theme. */
const ROLES: Record<string, string[]> = {
  '--bg': ['darker_background', 'dark_background', 'background'],
  '--pane': ['background'],
  '--pane-2': ['lighter_background', 'selection'],
  '--fg': ['foreground'],
  '--bright': ['bright_foreground', 'foreground'],
  '--dim': ['dark_foreground', 'foreground'],
  '--faint': ['muted', 'dark_foreground'],
  '--green': ['accent', 'green'],
  '--cyan': ['cyan', 'bright_cyan'],
  '--magenta': ['magenta', 'bright_magenta'],
  '--amber': ['yellow', 'orange'],
  '--red': ['red'],
};

function clearTheme() {
  for (const name of Object.keys(ROLES)) document.documentElement.style.removeProperty(name);
}

async function applySystem() {
  const { colors } = await api.theme();
  for (const [name, keys] of Object.entries(ROLES)) {
    const value = keys.map((key) => colors[key]).find(Boolean);
    if (value) document.documentElement.style.setProperty(name, value);
    else document.documentElement.style.removeProperty(name);
  }
}

let mode: 'olive' | 'system' = 'olive';

export function setThemeMode(next: 'olive' | 'system') {
  mode = next;
  if (next === 'system') void applySystem().catch(() => {});
  else clearTheme();
}

export function themeMode() {
  return mode;
}

export function startTheme() {
  api.settings().then((s) => setThemeMode(s.theme === 'system' ? 'system' : 'olive')).catch(() => {});
  onServerEvent((event) => {
    if (event.type === 'theme' && mode === 'system') void applySystem().catch(() => {});
  });
}
