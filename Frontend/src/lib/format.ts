import type { MessageDoc } from '../types';

export const initials = (name: string) =>
  name.trim().split(/\s+/).map((w) => w[0] ?? '').slice(0, 2).join('').toUpperCase() || '?';

export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });

export const fmtDay = (ts: number) =>
  new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'long' });

export const isHttpUrl = (s: string) => {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
};

// Подтверждённые — по ULID (он совпадает с хронологией), неподтверждённые — в конец по времени.
export function sortMessages(a: MessageDoc, b: MessageDoc): number {
  if (a.id && b.id) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (a.id) return -1;
  if (b.id) return 1;
  return a.createdAt - b.createdAt;
}
