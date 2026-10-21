import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { initials } from '../lib/format';

export function Avatar({ name, url, online, size = 40 }: { name: string; url?: string | null; online?: boolean; size?: number }) {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [url]);
  return (
    <div className="ava" style={{ width: size, height: size, fontSize: size * 0.35 }}>
      {url && !bad ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBad(true)} /> : initials(name)}
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
