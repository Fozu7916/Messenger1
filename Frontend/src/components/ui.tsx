import { BASE } from '../lib/api';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { initials, isHttpUrl } from '../lib/format';

// Приглушённые плоские тона (белый текст на каждом читается, контраст ≥ 4.5)
const PALETTE = ['#b5532f', '#7a6a2f', '#3f7d6a', '#4a5f8a', '#8a4f7d', '#6b6f3a', '#9a5b3c', '#3d6e8f'];
// Один и тот же человек всегда получает один и тот же цвет аватарки
const colorOf = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
};
export function Avatar({ name, url, online, size = 40 }: { name: string; url?: string | null; online?: boolean; size?: number }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [url]);
  // старые/небезопасные ссылки (http, localhost, логин в URL) не загружаем — показываем инициалы
  // свои загруженные аватарки приходят путём /api/files/... — достраиваем адрес API
  const src = url?.startsWith('/api/files/') ? BASE + url : url && isHttpUrl(url) ? url : null;
  return (
    <div className="ava" style={{
      width: size, height: size, fontSize: size * 0.35,
      ...(src && !bad ? {} : { background: colorOf(name), color: '#fff' }),
    }}>
      {src && !bad ? <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setBad(true)} /> : initials(name)}
      {online && <i className="on" title="В сети" />}
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
