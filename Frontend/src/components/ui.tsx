import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { initials } from '../lib/format';

// Приглушённые цвета: читаются и на светлой, и на тёмной теме
const PALETTE = ['#5b7cfa', '#e0795b', '#3aa58a', '#c4893a', '#9b6bdc', '#d0607f', '#4a9cc9', '#7b8794'];
// Один и тот же человек всегда получает один и тот же цвет аватарки
const colorOf = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

export function Avatar({ name, url, online, size = 40 }: { name: string; url?: string | null; online?: boolean; size?: number }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [url]);
  const img = !!url && !bad;
  return (
    <div className="ava" style={{ width: size, height: size, fontSize: Math.round(size * 0.38), background: img ? 'var(--bg-3)' : colorOf(name) }}>
      {img ? <img src={url!} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setBad(true)} /> : initials(name)}
      {online !== undefined && <i className={online ? 'on' : ''} />}
    </div>
  );
}

const svg = (d: string) => () => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;
export const Icon = {
  Pencil: svg('M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4'),
  Trash: svg('M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3'),
  Send: svg('M5 12h13M13 6l6 6-6 6'),
  Check: svg('M5 12.5l4.5 4.5L19 7.5'),
  Checks: svg('M2 12.5l4.5 4.5L16 7.5M11 16l1 1 9.5-9.5'),
  Clock: svg('M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z'),
  Alert: svg('M12 8v5M12 16.5v.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z'),
  Back: svg('M15 5l-7 7 7 7'),
  Gear: svg('M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z'),
  Chat: svg('M4 5.5A2.5 2.5 0 016.5 3h11A2.5 2.5 0 0120 5.5v8a2.5 2.5 0 01-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 014 13.5v-8z'),
};

const ToastCtx = createContext<(t: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState('');
  const timer = useRef<number>();
  const show = useCallback((t: string) => {
    setText(t); clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setText(''), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {text && <div className="toast" role="status">{text}</div>}
    </ToastCtx.Provider>
  );
}
