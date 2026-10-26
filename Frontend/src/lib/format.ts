import type { MessageDoc } from '../types';

export const initials = (name: string) =>
  name.trim().split(/\s+/).map((w) => w[0] ?? '').slice(0, 2).join('').toUpperCase() || '?';

export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });

// Для списка диалогов: сегодня — время, на этой неделе — день недели, иначе — дата.
export const fmtWhen = (ts: number, now = Date.now()) => {
  const today = new Date(now).setHours(0, 0, 0, 0);
  if (ts >= today) return fmtTime(ts);
  if (ts >= today - 6 * 86_400_000) return new Date(ts).toLocaleDateString('ru', { weekday: 'short' });
  return new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'short' });
};

export const fmtDay = (ts: number) =>
  new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'long' });

// Только публичный https без логина/пароля и без локальных адресов (сервер проверяет то же самое).
export const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    if (u.protocol !== 'https:' || u.username || u.password || u.port || s.length > 2048) return false;
    if (h === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(h)) return false;
    if (/^\[|^\d+\.\d+\.\d+\.\d+$/.test(h) && /^(\[|0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(h)) return false;
    return h.includes('.') || h.startsWith('[');
  } catch { return false; }
};

export const fmtLastSeen = (ts: number, now = Date.now()) => {
  const diff = now - ts, d = new Date(ts), t = fmtTime(ts), today = new Date(now).setHours(0, 0, 0, 0);
  if (diff < 60_000) return 'был(а) в сети только что';
  if (ts >= today) return `был(а) в сети сегодня в ${t}`;
  if (ts >= today - 86_400_000) return `был(а) в сети вчера в ${t}`;
  return `был(а) в сети ${d.toLocaleDateString('ru', { day: 'numeric', month: 'long' })} в ${t}`;
};

// Подтверждённые — по ULID (он совпадает с хронологией), неподтверждённые — в конец по времени.
export function sortMessages(a: MessageDoc, b: MessageDoc): number {
  if (a.id && b.id) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (a.id) return -1;
  if (b.id) return 1;
  return a.createdAt - b.createdAt;
}
