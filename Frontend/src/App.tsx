import { useAuth } from './lib/auth';
import { ChatProvider, useChat } from './lib/chat';
import { usePersisted } from './lib/persist';
import { AuthPage } from './components/AuthPage';
import { ChatsPage } from './components/ChatsPage';
import { SettingsPage } from './components/SettingsPage';
import { Avatar } from './components/ui';

export default function App() {
  const { session } = useAuth();
  return session ? <ChatProvider><Shell /></ChatProvider> : <AuthPage />;
}

function Shell() {
  const { session } = useAuth();
  const { status, dbError, error } = useChat();
  const [tab, setTab] = usePersisted<'chats' | 'settings'>('tab', 'chats');
  const u = session!.user;
  const net = { online: '● На связи', connecting: '◌ Подключение…', offline: '○ Офлайн' }[status];

  return (
    <div className="app">
      <nav className="nav">
        <div className="logo"><s />Мессенджер</div>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === 'chats'} onClick={() => setTab('chats')}>Чаты</button>
          <button role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Настройки</button>
        </div>
        <span className="net" aria-live="polite" title={error || undefined}>{net}{error ? ' · ошибка синхронизации' : ''}</span>
        <button className="me-btn" onClick={() => setTab('settings')} aria-label="Профиль и настройки">
          <Avatar name={u.displayName} url={u.avatarUrl} size={32} />
        </button>
      </nav>
      {dbError && <div className="warn">Локальная база недоступна: {dbError}</div>}
      {tab === 'chats' ? <ChatsPage /> : <SettingsPage />}
    </div>
  );
}
