import { useState } from 'react';

// Состояние интерфейса, которое переживает обновление страницы (вкладка, открытый диалог).
export function usePersisted<T>(key: string, init: T): [T, (v: T) => void] {
  const k = 'ui:' + key;
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(k); return s ? (JSON.parse(s) as T) : init; } catch { return init; }
  });
  const set = (x: T) => {
    setV(x);
    try { localStorage.setItem(k, JSON.stringify(x)); } catch { /* ignore */ }
  };
  return [v, set];
}

export interface ScrollPos { top: number; bottom: boolean }
export const readScroll = (dialogId: string): ScrollPos | null => {
  try { return JSON.parse(localStorage.getItem('ui:scroll:' + dialogId) || 'null'); } catch { return null; }
};
export const saveScroll = (dialogId: string, p: ScrollPos) => {
  try { localStorage.setItem('ui:scroll:' + dialogId, JSON.stringify(p)); } catch { /* ignore */ }
};
export const clearUiState = () => {
  try { Object.keys(localStorage).filter((k) => k.startsWith('ui:')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
};
