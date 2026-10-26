import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { initials } from '../lib/format';

const PALETTE: [string, string][] = [
  ['#7c6cff', '#3d7bff'], ['#ff8a5c', '#e0457b'], ['#22c1a3', '#2d8cf0'],
  ['#f6b73c', '#ef6a4a'], ['#b05cff', '#ff5c9d'], ['#3ddc97', '#1f9ec9'],
];
// Один и тот же человек всегда получает один и тот же цвет аватарки
const colorOf = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

export function Avatar({ name, url, online, size = 40 }: { name: string; url?: string | null; online?: boolean; size?: number }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [url]);
  return (
    <div className="ava" style={{
      width: size, height: size, fontSize: size * 0.35,
      ...(url && !bad ? {} : { background: `linear-gradient(135deg, ${colorOf(name)[0]}, ${colorOf(name)[1]})`, color: '#fff' }),
    }}>
      {url && !bad ? <img src={url} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setBad(true)} /> : initials(name)}
      {online !== undefined && <i className={online ? 'on' : ''} />}
    </div>
  );
}

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
