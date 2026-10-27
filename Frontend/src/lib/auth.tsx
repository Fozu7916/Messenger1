import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import * as api from './api';
import { clearUiState } from './persist';
import type { AuthResponse, User } from '../types';

// token пустой, пока нет сети после запуска: интерфейс открывается из локальной базы, токен подтянется при первом обновлении.
interface Session { token: string; expiresAt: string; user: User }
interface Auth {
  session: Session | null;
  login(login: string, password: string): Promise<void>;
  register(v: { login: string; email: string; password: string; displayName?: string }): Promise<void>;
  logout(): void;
  updateProfile(v: { displayName: string; avatarUrl: string | null }): Promise<void>;
}
const Ctx = createContext<Auth>(null as unknown as Auth);
export const useAuth = () => useContext(Ctx);

// В localStorage — только профиль (чтобы понять, что пользователь входил и открыть интерфейс офлайн).
// Токены там не хранятся: access живёт в памяти, refresh — в httpOnly-cookie.
const KEY = 'session:user';
const readUser = (): User | null => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') as User | null; } catch { return null; } };
const REFRESH_AHEAD_MS = 60_000;
const RETRY_MS = 15_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  const store = useCallback((s: Session | null) => {
    api.setToken(s?.token || null);
    try { s ? localStorage.setItem(KEY, JSON.stringify(s.user)) : localStorage.removeItem(KEY); } catch { /* ignore */ }
    setSession(s);
  }, []);
  const fromResponse = useCallback((r: AuthResponse) => store({ token: r.accessToken, expiresAt: r.expiresAt, user: r.user }), [store]);
  const drop = useCallback(() => { store(null); clearUiState(); }, [store]);

  useEffect(() => { api.setUnauthorizedHandler(drop); api.setRefreshedHandler((r) => setSession({ token: r.accessToken, expiresAt: r.expiresAt, user: r.user })); }, [drop]);

  // Запуск: если пользователь входил раньше — пробуем восстановить сессию по cookie.
  useEffect(() => {
    let dead = false;
    (async () => {
      const user = readUser();
      if (user) {
        try {
          const r = await api.refresh();
          if (!dead) r ? fromResponse(r) : drop();
        } catch {
          // нет сети: открываем интерфейс из локальной базы, обновление повторит таймер ниже
          if (!dead) { setSession({ token: '', expiresAt: new Date(0).toISOString(), user }); }
        }
      }
      if (!dead) setReady(true);
    })();
    return () => { dead = true; };
  }, [fromResponse, drop]);

  // Обновляем токен заранее; если сети нет — повторяем.
  useEffect(() => {
    if (!session) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (ms: number) => { timer = setTimeout(run, Math.max(0, ms)); };
    const run = async () => {
      try {
        const r = await api.refresh();
        if (dead) return;
        if (r === null) drop();   // сессия закончилась на сервере
      } catch { if (!dead) schedule(RETRY_MS); }
    };
    schedule(Date.parse(session.expiresAt) - Date.now() - REFRESH_AHEAD_MS);
    return () => { dead = true; clearTimeout(timer); };
  }, [session?.expiresAt, drop]);

  const value: Auth = {
    session,
    login: async (l, p) => fromResponse(await api.login(l.trim(), p)),
    register: async (v) => fromResponse(await api.register({ ...v, login: v.login.trim(), email: v.email.trim() })),
    logout: () => { api.logout().catch(() => {}); drop(); },
    updateProfile: async (v) => { const user = await api.updateMe(v); store({ ...session!, user }); },
  };
  if (!ready) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
