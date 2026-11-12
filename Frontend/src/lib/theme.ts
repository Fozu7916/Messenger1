// Оформление: тема, акцент, обои, форма пузырей, плотность, размер и шрифт текста.
// Хранится в localStorage (мгновенно, офлайн) и синхронизируется с сервером (GET/PUT /api/users/me/appearance),
// поэтому на новом устройстве после входа вид подтягивается сам. Применяется переменными CSS на <html>.
// Загруженные обои — файлы в S3: тянем через fetch с токеном, кладём в Cache Storage (работает офлайн) и показываем blob-ссылкой.
import { useEffect, useState, useSyncExternalStore } from 'react';
import * as api from './api';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type Bubble = 'round' | 'soft' | 'square';
export type Density = 'compact' | 'normal' | 'cozy';
export type FontFamily = 'sans' | 'serif' | 'mono';
export interface Wall { kind: 'preset' | 'upload'; id: string; dim: number }   // dim 0..0.6 — затемнение картинки
export interface Appearance {
  mode: ThemeMode; accent: string;      // id из ACCENTS или цвет вида #rrggbb
  bubble: Bubble; density: Density; fontScale: number; font: FontFamily; wallpaper: Wall;
}

export const DEFAULTS: Appearance = {
  mode: 'auto', accent: 'vermilion', bubble: 'round', density: 'normal', fontScale: 1, font: 'sans',
  wallpaper: { kind: 'preset', id: 'dots', dim: 0 },
};

export interface Accent { id: string; name: string; light: [string, string]; dark: [string, string] }   // [цвет, цвет текста на нём]
export const ACCENTS: Accent[] = [
  { id: 'vermilion', name: 'Киноварь', light: ['#cc3d18', '#ffffff'], dark: ['#ff6a3d', '#1c0e08'] },
  { id: 'emerald', name: 'Изумруд', light: ['#1f7a52', '#ffffff'], dark: ['#4cc38a', '#08170f'] },
  { id: 'indigo', name: 'Индиго', light: ['#3b4fbf', '#ffffff'], dark: ['#8c9bff', '#0d1033'] },
  { id: 'ochre', name: 'Охра', light: ['#9a6a00', '#ffffff'], dark: ['#e8b04a', '#241700'] },
  { id: 'graphite', name: 'Графит', light: ['#2b2a27', '#ffffff'], dark: ['#e6e1d5', '#161512'] },
];

export interface Preset { id: string; name: string; light: string; dark: string }
const WAVES = (c: string) => `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='40'%3E%3Cpath d='M0 20Q20 0 40 20T80 20' fill='none' stroke='${c}' stroke-opacity='.2' stroke-width='1.5'/%3E%3C/svg%3E")`;
export const PRESETS: Preset[] = [
  { id: 'dots', name: 'Точки', light: 'radial-gradient(var(--line) 1px,transparent 1.2px) 0 0/24px 24px,var(--bg)', dark: 'radial-gradient(var(--line) 1px,transparent 1.2px) 0 0/24px 24px,var(--bg)' },
  { id: 'plain', name: 'Чистый', light: 'var(--bg)', dark: 'var(--bg)' },
  { id: 'lines', name: 'Линейка', light: 'repeating-linear-gradient(0deg,transparent 0 31px,var(--line) 31px 32px),var(--bg)', dark: 'repeating-linear-gradient(0deg,transparent 0 31px,var(--line) 31px 32px),var(--bg)' },
  { id: 'grid', name: 'Сетка', light: 'linear-gradient(var(--line) 1px,transparent 1px) 0 0/32px 32px,linear-gradient(90deg,var(--line) 1px,transparent 1px) 0 0/32px 32px,var(--bg)', dark: 'linear-gradient(var(--line) 1px,transparent 1px) 0 0/32px 32px,linear-gradient(90deg,var(--line) 1px,transparent 1px) 0 0/32px 32px,var(--bg)' },
  { id: 'waves', name: 'Волны', light: `${WAVES('%23524c41')},var(--bg)`, dark: `${WAVES('%23bcb5a5')},var(--bg)` },
  { id: 'dawn', name: 'Рассвет', light: 'linear-gradient(160deg,#f6e3d3,#e8d5e6 55%,#cfe0ee)', dark: 'linear-gradient(160deg,#2a1d1a,#241a2a 55%,#16212b)' },
  { id: 'dusk', name: 'Сумерки', light: 'linear-gradient(180deg,#f3d9c4,#e7b9a8 50%,#b9a2c4)', dark: 'linear-gradient(180deg,#2b1f2e,#1c1830 60%,#0e1424)' },
  { id: 'moss', name: 'Мох', light: 'linear-gradient(160deg,#dbe4d6,#c3d6bd)', dark: 'linear-gradient(160deg,#17201a,#0f150f)' },
  { id: 'graphite', name: 'Графит', light: 'linear-gradient(160deg,#dedad2,#c7c2b7)', dark: 'linear-gradient(160deg,#26231e,#121110)' },
];

const FONTS: Record<FontFamily, string> = { sans: "'Onest',system-ui,sans-serif", serif: "'Literata',Georgia,serif", mono: "'JetBrains Mono',ui-monospace,monospace" };
const RADII: Record<Bubble, string> = { round: '20px', soft: '14px', square: '6px' };
const PADS: Record<Density, string> = { compact: '5px', normal: '9px', cozy: '13px' };

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list as readonly unknown[]).includes(v) ? (v as T) : d;

// Данные могут прийти с сервера или из старой версии — берём только допустимое
function sanitize(x: any): Appearance {
  const w = x?.wallpaper;
  const kind = w?.kind === 'upload' && typeof w.id === 'string' && /^[0-9A-Za-z]{26}$/.test(w.id) ? 'upload' : 'preset';
  const id = kind === 'upload' ? w.id : PRESETS.some((p) => p.id === w?.id) ? w.id : DEFAULTS.wallpaper.id;
  const accent = typeof x?.accent === 'string' && (/^#[0-9a-fA-F]{6}$/.test(x.accent) || ACCENTS.some((a) => a.id === x.accent)) ? x.accent : DEFAULTS.accent;
  const scale = Number(x?.fontScale);
  const dim = Number(w?.dim);
  return {
    mode: oneOf(x?.mode, ['auto', 'light', 'dark'], DEFAULTS.mode),
    accent,
    bubble: oneOf(x?.bubble, ['round', 'soft', 'square'], DEFAULTS.bubble),
    density: oneOf(x?.density, ['compact', 'normal', 'cozy'], DEFAULTS.density),
    fontScale: Number.isFinite(scale) ? Math.min(1.3, Math.max(0.85, scale)) : 1,
    font: oneOf(x?.font, ['sans', 'serif', 'mono'], DEFAULTS.font),
    wallpaper: { kind, id, dim: kind === 'upload' && Number.isFinite(dim) ? Math.min(0.6, Math.max(0, dim)) : 0 },
  };
}

function load(): Appearance {
  try { const raw = read('appearance'); if (raw) return sanitize(JSON.parse(raw)); } catch { /* повреждённое значение — берём значения по умолчанию */ }
  return sanitize({ mode: read('theme'), accent: read('accent') });   // переход со старых отдельных ключей
}

let state: Appearance = load();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
export const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const getAppearance = () => state;
export const useAppearance = () => useSyncExternalStore(subscribe, getAppearance);

const systemDark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
export const isDark = () => state.mode === 'dark' || (state.mode === 'auto' && systemDark());
export const presetCss = (p: Preset, dark = isDark()) => (dark ? p.dark : p.light);

function accentColors(dark: boolean): [string, string] {
  if (state.accent.startsWith('#')) {
    const n = parseInt(state.accent.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return [state.accent, lum > 0.6 ? '#1c1a16' : '#ffffff'];
  }
  const a = ACCENTS.find((x) => x.id === state.accent) ?? ACCENTS[0];
  return dark ? a.dark : a.light;
}

// ---- обои-картинки ----
const blobUrls = new Map<string, string>();
const loading = new Set<string>();
async function loadBlob(id: string): Promise<string> {
  const key = `/wallpaper/${id}`;
  let blob: Blob | undefined;
  try { const c = await caches.open('wallpapers'); const hit = await c.match(key); if (hit) blob = await hit.blob(); } catch { /* Cache Storage недоступен */ }
  if (!blob) {
    blob = await api.wallpaperBlob(id);
    try { await (await caches.open('wallpapers')).put(key, new Response(blob)); } catch { /* не критично */ }
  }
  return URL.createObjectURL(blob);
}
function ensureBlob(id: string) {
  if (blobUrls.has(id) || loading.has(id)) return;
  loading.add(id);
  loadBlob(id)
    .then((url) => { blobUrls.set(id, url); applyTheme(); emit(); })
    .catch((e) => { if (e instanceof api.ApiError && e.status === 404) update({ wallpaper: DEFAULTS.wallpaper }); })
    .finally(() => { loading.delete(id); });
}
/** Ссылка на загруженные обои для превью в настройках (null, пока грузятся). */
export function useWallpaperUrl(id: string): string | null {
  const [url, setUrl] = useState<string | null>(blobUrls.get(id) ?? null);
  useEffect(() => {
    let alive = true;
    if (!blobUrls.has(id)) loadBlob(id).then((u) => { blobUrls.set(id, u); if (alive) setUrl(u); }).catch(() => {});
    return () => { alive = false; };
  }, [id]);
  return url;
}

function wallCss(dark: boolean): string {
  const w = state.wallpaper;
  if (w.kind === 'upload') {
    const url = blobUrls.get(w.id);
    if (url) return `linear-gradient(rgba(0,0,0,${w.dim}),rgba(0,0,0,${w.dim})),url("${url}") center/cover no-repeat,var(--bg)`;
    ensureBlob(w.id);   // пока картинка грузится — обычный фон
  }
  return presetCss(PRESETS.find((p) => p.id === (w.kind === 'preset' ? w.id : DEFAULTS.wallpaper.id)) ?? PRESETS[0], dark);
}

export function applyTheme() {
  const dark = isDark();
  const [color, ink] = accentColors(dark);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set('--accent', color); set('--accent-ink', ink);
  set('--br', RADII[state.bubble]); set('--msg-py', PADS[state.density]);
  set('--fs', String(state.fontScale)); set('--msg-font', FONTS[state.font]);
  set('--wall', wallCss(dark));
}

// ---- изменение и синхронизация ----
let syncTimer: number | undefined;
function scheduleSync() {
  if (!api.getToken()) return;
  clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => { api.putAppearance(state).catch(() => {}); }, 800);
}
export function update(patch: Partial<Appearance>) {
  state = sanitize({ ...state, ...patch });
  write('appearance', JSON.stringify(state));
  applyTheme(); emit(); scheduleSync();
}
export const reset = () => update(DEFAULTS);

/** После входа: подтягиваем оформление с сервера (оно главнее локального); если там пусто — отправляем своё. */
export async function loadRemoteAppearance() {
  try {
    const remote = await api.getAppearance();
    if (remote && Object.keys(remote).length) {
      state = sanitize(remote);
      write('appearance', JSON.stringify(state));
      applyTheme(); emit();
    } else if (JSON.stringify(state) !== JSON.stringify(DEFAULTS)) await api.putAppearance(state);
  } catch { /* нет сети — остаётся локальное */ }
}

// В режиме «авто» следуем за системной темой без перезагрузки
if (typeof matchMedia === 'function') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.mode === 'auto') { applyTheme(); emit(); } });
}
