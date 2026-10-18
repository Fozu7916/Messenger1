import type { AuthResponse, Dialog, Message, User } from './types';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:5080';
export type Session = AuthResponse;

/* ---------- сессия и состояние интерфейса (переживают обновление страницы) ---------- */
const SKEY = 'msgr.session';
export const store = {
  load(): Session | null {
    try {
      const s = JSON.parse(localStorage.getItem(SKEY) ?? 'null') as Session | null;
      return s && new Date(s.expiresAt) > new Date() ? s : null;
    } catch { return null; }
  },
  save(s: Session) { localStorage.setItem(SKEY, JSON.stringify(s)); },
  clear() { localStorage.removeItem(SKEY); },
};
export const token = () => store.load()?.accessToken ?? '';

const UIK = 'msgr.ui';
interface UiState { dialogId: string | null; scroll: Record<string, number> }
let st: UiState | null = null;
let timer = 0;
export const ui = {
  load(): UiState {
    if (!st) {
      try { st = { dialogId: null, scroll: {}, ...JSON.parse(localStorage.getItem(UIK) ?? '{}') }; }
      catch { st = { dialogId: null, scroll: {} }; }
    }
    return st!;
  },
  save(p: Partial<UiState>) { st = { ...ui.load(), ...p }; localStorage.setItem(UIK, JSON.stringify(st)); },
  /** off — расстояние от нижнего края ленты в px */
  setScroll(id: string, off: number) {
    ui.load().scroll[id] = off;
    clearTimeout(timer);
    timer = window.setTimeout(() => ui.save({}), 250);
  },
  clear() { st = null; localStorage.removeItem(UIK); },
};

/* ---------- HTTP ---------- */
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };

async function req<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const headers: Record<string, string> = init.body ? { 'Content-Type': 'application/json' } : {};
  if (auth) headers.Authorization = `Bearer ${token()}`;
  let res: Response;
  try { res = await fetch(API_URL + path, { ...init, headers }); }
  catch { throw new ApiError(0, 'Нет соединения с сервером'); }
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    if (res.status === 401 && auth) onUnauthorized();
    const p = await res.json().catch(() => null);
    const first = p?.errors ? (Object.values(p.errors) as string[][])[0]?.[0] : undefined;
    throw new ApiError(res.status, first ?? p?.title ?? `Ошибка ${res.status}`);
  }
  return res.json();
}
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  register: (b: { login: string; email: string; password: string; displayName: string }) =>
    req<AuthResponse>('/api/auth/register', post(b), false),
  login: (b: { login: string; password: string }) => req<AuthResponse>('/api/auth/login', post(b), false),
  logout: () => req<void>('/api/auth/logout', { method: 'POST' }).catch(() => {}),
  me: () => req<User>('/api/users/me'),
  updateMe: (b: { displayName: string; avatarUrl: string | null }) =>
    req<User>('/api/users/me', { method: 'PUT', body: JSON.stringify(b) }),
  search: (q: string) => req<User[]>(`/api/users?query=${encodeURIComponent(q)}`),
  dialogs: () => req<Dialog[]>('/api/dialogs'),
  createDialog: (userId: string) => req<Dialog>('/api/dialogs', post({ userId })),
  deleteDialog: (id: string) => req<void>(`/api/dialogs/${id}`, { method: 'DELETE' }),
  messages: (id: string, p: { before?: string; after?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    Object.entries(p).forEach(([k, v]) => v !== undefined && q.set(k, String(v)));
    return req<Message[]>(`/api/dialogs/${id}/messages?${q}`);
  },
  deleteMessage: (id: string) => req<void>(`/api/messages/${id}`, { method: 'DELETE' }),
};
