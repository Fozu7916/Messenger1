import { useAuth } from './lib/auth';
import { ChatProvider, useChat } from './lib/chat';
import { usePersisted } from './lib/persist';
import { AuthPage } from './components/AuthPage';
import { ChatsPage } from './components/ChatsPage';
import { SettingsPage } from './components/SettingsPage';

export default function App() {
  const { session } = useAuth();
  return session ? <ChatProvider><Shell /></ChatProvider> : <AuthPage />;
}

function Shell() {
  const { dbError } = useChat();
  const [tab, setTab] = usePersisted<'chats' | 'settings'>('tab', 'chats');
  return (
    <div className="app">
      {dbError && <div className="warn">Локальная база недоступна: {dbError}</div>}
      {tab === 'chats'
        ? <ChatsPage onSettings={() => setTab('settings')} />
        : <SettingsPage onBack={() => setTab('chats')} />}
    </div>
  );
}
