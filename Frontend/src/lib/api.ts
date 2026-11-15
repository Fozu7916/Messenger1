import type { AuthResponse, DialogDto, Member, MessageDto, Profile, User } from '../types';

export const BASE: string = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let token: string | null = null;
let onUnauthorized: () => void = () => {};
export const setToken = (t: string | null) => { token = t; };
export const getToken = () => token;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };
let onRefreshed: (r: AuthResponse) => void = () => {};
export const setRefreshedHandler = (fn: (r: AuthResponse) => void) => { onRefreshed = fn; };

// Refresh-токен лежит в httpOnly-cookie (JS его не видит). Один запрос на всех: параллельные вкладки/запросы ждут общий результат.
// Возвращает null, если сессия закончилась; бросает ApiError(0), если нет сети (сессию при этом не сбрасываем).
let refreshing: Promise<AuthResponse | null> | null = null;
export function refresh(): Promise<AuthResponse | null> {
  refreshing ??= (async () => {
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'fetch' } });
    } catch {
      throw new ApiError(0, 'Нет соединения с сервером');
    }
    if (res.status === 401 || res.status === 400) return null;
    if (!res.ok) throw new ApiError(res.status, 'Сервер недоступен, попробуйте позже');
    const r = (await res.json()) as AuthResponse;
    token = r.accessToken;
    onRefreshed(r);
    return r;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

const FALLBACK: Record<number, string> = {
  400: 'Проверьте введённые данные', 413: 'Файл слишком большой', 401: 'Неверные данные или истёкшая сессия',
  404: 'Не найдено', 409: 'Такой логин или email уже занят', 429: 'Слишком много запросов — подождите минуту',
};

// application/problem+json (RFC 7807): берём первую ошибку валидации, иначе detail/title.
function problemText(status: number, data: any): string {
  const first = data?.errors ? (Object.values(data.errors)[0] as string[] | undefined)?.[0] : undefined;
  return first || data?.detail || FALLBACK[status] || (status >= 500 ? 'Сервер недоступен, попробуйте позже' : 'Что-то пошло не так');
}

async function req<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'include',
      headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Нет соединения с сервером');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token && !retried && !path.startsWith('/api/auth/')) {
      // access-токен мог истечь — тихо обновляем и повторяем запрос один раз
      const r = await refresh().catch(() => undefined);
      if (r) return req<T>(method, path, body, true);
      if (r === null) onUnauthorized();
    } else if (res.status === 401 && token && retried) onUnauthorized();
    throw new ApiError(res.status, problemText(res.status, data));
  }
  return data as T;
}

export const register = (v: { login: string; email: string; password: string; displayName?: string }) =>
  req<AuthResponse>('POST', '/api/auth/register', v);
export const login = (login: string, password: string) => req<AuthResponse>('POST', '/api/auth/login', { login, password });
export const logout = () => req<void>('POST', '/api/auth/logout');
// bio: не передавать — не менять; '' — очистить
export const updateMe = (v: { displayName: string; avatarUrl: string | null; bio?: string }) => req<Profile>('PUT', '/api/users/me', v);
export const me = () => req<Profile>('GET', '/api/users/me');
export const profile = (id: string) => req<Profile>('GET', `/api/users/${id}`);
export const changePassword = (currentPassword: string, newPassword: string) =>
  req<void>('POST', '/api/auth/password', { currentPassword, newPassword });
// Список «Люди» без поиска: все по алфавиту имени.
export const users = (p: { query?: string; offset?: number; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (p.query) q.set('query', p.query);
  if (p.offset) q.set('offset', String(p.offset));
  if (p.limit) q.set('limit', String(p.limit));
  return req<User[]>('GET', `/api/users?${q}`);
};
// Поиск людей по частям: слова в логине и имени в любом порядке («пет ив» найдёт «Иван Петров»).
export const searchUsers = (q: string, p: { scope?: 'all' | 'contacts'; offset?: number; limit?: number } = {}) => {
  const s = new URLSearchParams({ q });
  if (p.scope) s.set('scope', p.scope);
  if (p.offset) s.set('offset', String(p.offset));
  if (p.limit) s.set('limit', String(p.limit));
  return req<User[]>('GET', `/api/users/search?${s}`);
};
export const dialogs = () => req<DialogDto[]>('GET', '/api/dialogs');
export const createDialog = (userId: string) => req<DialogDto>('POST', '/api/dialogs', { userId });
export const deleteDialog = (id: string) => req<void>('DELETE', `/api/dialogs/${id}`);
// scope: 'me' — скрыть только у себя, 'all' — удалить у обоих участников (как в Telegram)
export const deleteMessage = (id: string, scope: 'me' | 'all' = 'all') => req<void>('DELETE', `/api/messages/${id}?scope=${scope}`);
export const editMessage = (id: string, text: string) => req<MessageDto>('PUT', `/api/messages/${id}`, { text });
// Поиск по тексту сообщений (слова в любом порядке) во всех своих диалогах, от новых к старым.
export const searchMessages = (q: string, p: { dialogId?: string; before?: string; limit?: number } = {}) => {
  const s = new URLSearchParams({ q });
  if (p.dialogId) s.set('dialogId', p.dialogId);
  if (p.before) s.set('before', p.before);
  if (p.limit) s.set('limit', String(p.limit));
  return req<MessageDto[]>('GET', `/api/messages/search?${s}`);
};
export const messages = (dialogId: string, p: { after?: string; before?: string; limit?: number }) => {
  const q = new URLSearchParams();
  if (p.after) q.set('after', p.after);
  if (p.before) q.set('before', p.before);
  if (p.limit) q.set('limit', String(p.limit));
  return req<MessageDto[]>('GET', `/api/dialogs/${dialogId}/messages?${q}`);
};
export const pins = (dialogId: string) => req<MessageDto[]>('GET', `/api/dialogs/${dialogId}/pins`);
export const pin = (dialogId: string, id: string) => req<void>('PUT', `/api/dialogs/${dialogId}/pins/${id}`);
export const reactions = (dialogId: string) => req<{ messageId: string; userId: string; emoji: string }[]>('GET', `/api/dialogs/${dialogId}/reactions`);
export const react = (dialogId: string, id: string, emoji: string) => req<void>('PUT', `/api/dialogs/${dialogId}/reactions/${id}`, { emoji });
export const unreact = (dialogId: string, id: string) => req<void>('DELETE', `/api/dialogs/${dialogId}/reactions/${id}`);
export const unpin = (dialogId: string, id: string) => req<void>('DELETE', `/api/dialogs/${dialogId}/pins/${id}`);
// Пересылка до 50 сообщений в другой свой диалог; clientBatchId делает повтор безопасным
export const forward = (dialogId: string, v: { toDialogId: string; messageIds: string[]; clientBatchId: string }) =>
  req<MessageDto[]>('POST', `/api/dialogs/${dialogId}/forward`, v);

// ---- Файлы: аватар, обои, оформление ----
const form = (file: File) => { const f = new FormData(); f.append('file', file); return f; };
export const uploadAvatar = (file: File) => req<Profile>('POST', '/api/users/me/avatar', form(file));
export const deleteAvatar = () => req<Profile>('DELETE', '/api/users/me/avatar');
export interface Wallpaper { id: string }
export const wallpapers = () => req<Wallpaper[]>('GET', '/api/users/me/wallpapers');
export const uploadWallpaper = (file: File) => req<Wallpaper>('POST', '/api/users/me/wallpapers', form(file));
export const deleteWallpaper = (id: string) => req<void>('DELETE', `/api/users/me/wallpapers/${id}`);
export const getAppearance = () => req<Record<string, unknown>>('GET', '/api/users/me/appearance');
export const putAppearance = (v: object) => req<void>('PUT', '/api/users/me/appearance', v);

// Приватный файл по токену → Blob (обычный <img>/<audio> не умеет слать Authorization)
export async function authedBlob(path: string, retried = false): Promise<Blob> {
  let res: Response;
  try { res = await fetch(`${BASE}${path}`, { credentials: 'include', headers: token ? { Authorization: `Bearer ${token}` } : {} }); }
  catch { throw new ApiError(0, 'Нет соединения с сервером'); }
  if (res.status === 401 && token && !retried && (await refresh().catch(() => null))) return authedBlob(path, true);
  if (!res.ok) throw new ApiError(res.status, problemText(res.status, null));
  return res.blob();
}
export const wallpaperBlob = (id: string) => authedBlob(`/api/users/me/wallpapers/${id}`);

// ---- Беседы ----
export const createGroup = (title: string, memberIds: string[]) => req<DialogDto>('POST', '/api/dialogs/group', { title, memberIds });
export const groupMembers = (id: string) => req<Member[]>('GET', `/api/dialogs/${id}/members`);
export const renameGroup = (id: string, title: string) => req<void>('PUT', `/api/dialogs/${id}`, { title });
export const addMembers = (id: string, userIds: string[]) => req<Member[]>('POST', `/api/dialogs/${id}/members`, { userIds });
export const removeMember = (id: string, userId: string) => req<void>('DELETE', `/api/dialogs/${id}/members/${userId}`);   // userId = 'me' — выйти
export const uploadGroupAvatar = (id: string, file: File) => req<void>('POST', `/api/dialogs/${id}/avatar`, form(file));
export const deleteGroupAvatar = (id: string) => req<void>('DELETE', `/api/dialogs/${id}/avatar`);

// ---- Фото и голосовые ----
export function sendMedia(dialogId: string, v: { clientMessageId: string; kind: 'image' | 'voice'; file: Blob; text?: string; durationMs?: number; replyToId?: string }) {
  const f = new FormData();
  f.append('file', v.file, v.kind === 'voice' ? 'voice' : 'photo');
  f.append('clientMessageId', v.clientMessageId);
  f.append('kind', v.kind);
  if (v.text) f.append('text', v.text);
  if (v.durationMs) f.append('durationMs', String(Math.round(v.durationMs)));
  if (v.replyToId) f.append('replyToId', v.replyToId);
  return req<MessageDto>('POST', `/api/dialogs/${dialogId}/messages/media`, f);
}

// ---- Видео: ссылка → PUT прямо в хранилище → подтверждение ----
export interface VideoUpload { fileId: string; ext: 'mp4' | 'webm'; uploadUrl: string; contentType: string; expiresAt: string }
export const videoUpload = (dialogId: string, v: { contentType: string; size: number; durationMs: number }) =>
  req<VideoUpload>('POST', `/api/dialogs/${dialogId}/video/upload`, v);
export function sendVideo(dialogId: string, v: { clientMessageId: string; fileId: string; ext: string; text?: string; durationMs: number; width: number; height: number; replyToId?: string; poster?: Blob | null }) {
  const f = new FormData();
  f.append('clientMessageId', v.clientMessageId); f.append('fileId', v.fileId); f.append('ext', v.ext);
  f.append('durationMs', String(Math.round(v.durationMs))); f.append('width', String(v.width)); f.append('height', String(v.height));
  if (v.text) f.append('text', v.text);
  if (v.replyToId) f.append('replyToId', v.replyToId);
  if (v.poster) f.append('poster', v.poster, 'poster.jpg');
  return req<MessageDto>('POST', `/api/dialogs/${dialogId}/messages/video`, f);
}
export const mediaLink = (dialogId: string, name: string) => req<{ url: string }>('GET', `/api/dialogs/${dialogId}/media/${name}/url`);
