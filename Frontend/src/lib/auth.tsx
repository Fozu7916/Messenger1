import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import * as api from './api';
import { clearUiState } from './persist';
import type { AuthResponse, User } from '../types';

interface Session { token: string; expiresAt: string; user: User }
interface Auth {
  session: Session | null;
  login(login: string, password: string): Promise<void>;
  register(v: { login: string; email: string; password: string; displayName: string }): Promise<void>;
  logout(): void;
  updateProfile(v: { displayName: string; avatarUrl: string | null }): Promise<void>;
}
const Ctx = createContext<Auth>(null as unknown as Auth);
export const useAuth = () => useContext(Ctx);
const KEY = 'session';

function read(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null') as Session | null;
    return s && Date.parse(s.expiresAt) > Date.now() ? s : null;
  } catch { return null; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => { const s = read(); api.setToken(s?.token ?? null); return s; });

  const store = useCallback((s: Session | null) => {
    api.setToken(s?.token ?? null);
    try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* ignore */ }
    setSession(s);
  }, []);
  const fromResponse = (r: AuthResponse) => store({ token: r.accessToken, expiresAt: r.expiresAt, user: r.user });

  // Refresh-токенов пока нет: по истечении access-токена или при 401 — возвращаем на экран входа.
  useEffect(() => { api.setUnauthorizedHandler(() => { store(null); clearUiState(); }); }, [store]);
  useEffect(() => {
    if (!session) return;
    const t = setTimeout(() => { store(null); clearUiState(); }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    return () => clearTimeout(t);
  }, [session?.token]);

  const value: Auth = {
    session,
    login: async (l, p) => fromResponse(await api.login(l.trim(), p)),
    register: async (v) => fromResponse(await api.register({ ...v, login: v.login.trim(), email: v.email.trim() })),
    logout: () => { api.logout().catch(() => {}); store(null); clearUiState(); },
    updateProfile: async (v) => { const user = await api.updateMe(v); store({ ...session!, user }); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
