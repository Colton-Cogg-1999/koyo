import { api, onServerEvent } from './api';

/** Which Omarchy colour drives each UI variable when following the system theme. */
const ROLES: Record<string, string[]> = {
  '--surface-app': ['darker_background', 'dark_background', 'background'],
  '--surface-reading': ['background'],
  '--surface-sidebar': ['background'],
  '--surface-hover': ['lighter_background', 'selection'],
  '--divider': ['selection', 'muted'],
  '--surface-raised': ['lighter_background', 'selection'],
  '--text-primary': ['bright_foreground', 'foreground'],
  '--text-secondary': ['dark_foreground', 'foreground'],
  '--text-muted': ['muted', 'dark_foreground'],
  '--accent': ['accent', 'green'],
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
