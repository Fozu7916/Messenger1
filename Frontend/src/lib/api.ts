import type { AuthResponse, DialogDto, MessageDto, User } from '../types';

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
  400: 'Проверьте введённые данные', 401: 'Неверные данные или истёкшая сессия',
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
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
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
export const refresh = () => req<AuthResponse>('POST', '/api/auth/refresh');
export const updateMe = (v: { displayName: string; avatarUrl: string | null }) => req<User>('PUT', '/api/users/me', v);
// Люди: поиск по логину и имени, минимум 2 символа (короче — сервер вернёт пустой список).
export const users = (p: { query?: string; offset?: number; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (p.query) q.set('query', p.query);
  if (p.offset) q.set('offset', String(p.offset));
  if (p.limit) q.set('limit', String(p.limit));
  return req<User[]>('GET', `/api/users?${q}`);
};
export const dialogs = () => req<DialogDto[]>('GET', '/api/dialogs');
export const createDialog = (userId: string) => req<DialogDto>('POST', '/api/dialogs', { userId });
export const deleteDialog = (id: string) => req<void>('DELETE', `/api/dialogs/${id}`);
// scope: 'me' — скрыть только у себя, 'all' — удалить у обоих участников (как в Telegram)
export const deleteMessage = (id: string, scope: 'me' | 'all' = 'all') => req<void>('DELETE', `/api/messages/${id}?scope=${scope}`);
export const editMessage = (id: string, text: string) => req<MessageDto>('PUT', `/api/messages/${id}`, { text });
// Поиск по тексту во всех своих диалогах, от новых к старым.
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
