import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as api from './api';
import { wipeDb } from './db';
import { clearUiState } from './persist';
import type { AuthResponse, User } from '../types';

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
const KEY = 'session';
// Продлеваем сессию заранее: за 5 минут до истечения (или на середине срока, если он короче 10 минут).
const REFRESH_LEAD_MS = 5 * 60_000;
const RETRY_MS = 30_000;

function read(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null') as Session | null;
    return s && Date.parse(s.expiresAt) > Date.now() ? s : null;
  } catch { return null; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => { const s = read(); api.setToken(s?.token ?? null); return s; });
  const sessionRef = useRef(session);

  const store = useCallback((s: Session | null) => {
    api.setToken(s?.token ?? null);
    try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* ignore */ }
    sessionRef.current = s;
    setSession(s);
  }, []);
  const fromResponse = useCallback((r: AuthResponse) => store({ token: r.accessToken, expiresAt: r.expiresAt, user: r.user }), [store]);
  const expire = useCallback(() => { store(null); clearUiState(); }, [store]);

  useEffect(() => { api.setUnauthorizedHandler(expire); }, [expire]);

  // Скользящая сессия: пока вкладка открыта, токен продлевается и пользователя не выкидывает на экран входа.
  useEffect(() => {
    if (!session) return;
    const exp = Date.parse(session.expiresAt);
    const life = exp - Date.now();
    let timer = 0;
    const attempt = async () => {
      try { fromResponse(await api.refresh()); }
      catch (e) {
        // 401 уже обработан (expire); сеть недоступна — пробуем ещё, пока токен жив
        if (e instanceof api.ApiError && e.status === 401) return;
        if (Date.now() + RETRY_MS < exp) timer = window.setTimeout(attempt, RETRY_MS);
        else timer = window.setTimeout(expire, Math.max(0, exp - Date.now()));
      }
    };
    timer = window.setTimeout(attempt, Math.max(0, life > 2 * REFRESH_LEAD_MS ? life - REFRESH_LEAD_MS : life / 2));
    return () => clearTimeout(timer);
  }, [session?.token]);

  const value: Auth = {
    session,
    login: async (l, p) => fromResponse(await api.login(l.trim(), p)),
    register: async (v) => fromResponse(await api.register({ ...v, login: v.login.trim(), email: v.email.trim() })),
    logout: () => {
      const uid = sessionRef.current?.user.id;
      api.logout().catch(() => {});
      expire();
      if (uid) void wipeDb(uid);
    },
    updateProfile: async (v) => { const user = await api.updateMe(v); store({ ...sessionRef.current!, user }); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
