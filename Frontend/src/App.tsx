import { useEffect, useState } from 'react';
import { api, setUnauthorizedHandler, store, ui, type Session } from './api';
import { Auth } from './Auth';
import { ChatProvider } from './chat';
import { Shell } from './Shell';

export function App() {
  const [session, setSession] = useState<Session | null>(() => store.load());
  const [checked, setChecked] = useState(!session);

  const logout = () => { store.clear(); ui.clear(); setSession(null); };
  const save = (s: Session) => { store.save(s); setSession(s); };

  useEffect(() => { setUnauthorizedHandler(logout); }, []);

  // При старте проверяем токен: 401 → api вызовет logout; офлайн — работаем с локальными данными.
  useEffect(() => {
    if (!session) return;
    api.me().then((user) => save({ ...session, user })).catch(() => {}).finally(() => setChecked(true));
  }, []);

  if (!session) return <Auth onAuth={save} />;
  if (!checked) return null;
  return (
    <ChatProvider key={session.user.id} me={session.user} onUser={(user) => save({ ...session, user })} onLogout={logout}>
      <Shell />
    </ChatProvider>
  );
}
