import type { AuthResponse, DialogDto, MessageDto, User } from '../types';

export const BASE: string = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let token: string | null = null;
let onUnauthorized: () => void = () => {};
export const setToken = (t: string | null) => { token = t; };
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

const FALLBACK: Record<number, string> = {
  400: 'Проверьте введённые данные', 401: 'Неверные данные или истёкшая сессия',
  404: 'Не найдено', 409: 'Такой логин или email уже занят', 429: 'Слишком много запросов — подождите минуту',
};

// application/problem+json (RFC 7807): берём первую ошибку валидации, иначе detail/title.
function problemText(status: number, data: any): string {
  const first = data?.errors ? (Object.values(data.errors)[0] as string[] | undefined)?.[0] : undefined;
  return first || data?.detail || FALLBACK[status] || (status >= 500 ? 'Сервер недоступен, попробуйте позже' : 'Что-то пошло не так');
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Нет соединения с сервером');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, problemText(res.status, data));
  }
  return data as T;
}

export const register = (v: { login: string; email: string; password: string; displayName: string }) =>
  req<AuthResponse>('POST', '/api/auth/register', v);
export const login = (login: string, password: string) => req<AuthResponse>('POST', '/api/auth/login', { login, password });
export const logout = () => req<void>('POST', '/api/auth/logout');
export const updateMe = (v: { displayName: string; avatarUrl: string | null }) => req<User>('PUT', '/api/users/me', v);
export const searchUsers = (q: string) => req<User[]>('GET', `/api/users?query=${encodeURIComponent(q)}`);
export const dialogs = () => req<DialogDto[]>('GET', '/api/dialogs');
export const createDialog = (userId: string) => req<DialogDto>('POST', '/api/dialogs', { userId });
export const deleteDialog = (id: string) => req<void>('DELETE', `/api/dialogs/${id}`);
export const deleteMessage = (id: string) => req<void>('DELETE', `/api/messages/${id}`);
export const messages = (dialogId: string, p: { after?: string; before?: string; limit?: number }) => {
  const q = new URLSearchParams();
  if (p.after) q.set('after', p.after);
  if (p.before) q.set('before', p.before);
  if (p.limit) q.set('limit', String(p.limit));
  return req<MessageDto[]>('GET', `/api/dialogs/${dialogId}/messages?${q}`);
};
