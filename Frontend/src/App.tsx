import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './lib/auth';
import { ChatProvider, useChat, useLiveQuery } from './lib/chat';
import { usePersisted } from './lib/persist';
import { loadRemoteAppearance } from './lib/theme';
import { AuthPage } from './components/AuthPage';
import { ChatsPage } from './components/ChatsPage';
import { PeoplePage } from './components/PeoplePage';
import { SettingsPage } from './components/SettingsPage';
import { Avatar } from './components/ui';
import type { DialogDoc } from './types';

export default function App() {
  const { session } = useAuth();
  return session ? <ChatProvider><Shell /></ChatProvider> : <AuthPage />;
}

type Tab = 'chats' | 'people' | 'settings';
const Icon = ({ d, extra }: { d: string; extra?: ReactNode }) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} />{extra}</svg>;
const IconChats = () => <Icon d="M4 6.5A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v7a2.5 2.5 0 01-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 014 13.5v-7z" />;
const IconPeople = () => <Icon d="M3.5 19c.5-3 3-4.5 5.5-4.5s5 1.5 5.5 4.5M15.5 14.8c2.4.1 4.4 1.5 5 4.2" extra={<><circle cx="9" cy="8.5" r="3.2" /><path d="M15.2 5.6a3.2 3.2 0 010 5.8" /></>} />;
const IconSettings = () => <Icon d="M4 7h10M18 7h2M4 17h2M10 17h10" extra={<><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>} />;

function Shell() {
  const { session } = useAuth();
  const { status, dbError, error } = useChat();
  const [tab, setTab] = usePersisted<Tab>('tab', 'chats');
  const [, setActive] = usePersisted<string | null>('dialog', null);
  const [peopleQ, setPeopleQ] = useState('');
  useEffect(() => { void loadRemoteAppearance(); }, []);   // тема, обои и т. д. подтягиваются с сервера на любом устройстве
  const dialogs = useLiveQuery<DialogDoc>((d) => d.dialogs.find(), []);
  const unread = dialogs.reduce((s, d) => s + d.unread, 0);
  const u = session!.user;
  const net = { online: 'На связи', connecting: 'Подключение…', offline: 'Офлайн' }[status];
  const tabs: [Tab, string, ReactNode][] = [['chats', 'Чаты', <IconChats />], ['people', 'Люди', <IconPeople />], ['settings', 'Настройки', <IconSettings />]];
  return (
    <div className="app">
      <nav className="nav" aria-label="Разделы">
        <div className="logo" aria-hidden="true">м</div>
        <div className="navtabs" role="tablist">
          {tabs.map(([id, label, icon]) => (
            <button key={id} role="tab" className="navbtn" aria-selected={tab === id} onClick={() => setTab(id)}>
              <span className="ico">{icon}{id === 'chats' && unread > 0 && <b className="navbadge">{unread > 99 ? '99+' : unread}</b>}</span>
              <span>{label}</span>
            </button>
          ))}
        </div>
        <span className={'net ' + status} role="status" aria-live="polite" title={error ? `${net} · ошибка синхронизации: ${error}` : net}>
          <span className="sr">{net}{error ? ' · ошибка синхронизации' : ''}</span>
        </span>
        <button className="me-btn" onClick={() => setTab('settings')} aria-label="Профиль и настройки">
          <Avatar name={u.displayName} url={u.avatarUrl} size={40} />
        </button>
      </nav>
      {dbError && <div className="warn">Локальная база недоступна: {dbError}</div>}
      {tab === 'chats' && <ChatsPage onFindPeople={(q) => { setPeopleQ(q); setTab('people'); }} />}
      {tab === 'people' && <PeoplePage initialQuery={peopleQ} onOpenDialog={(id) => { setActive(id); setTab('chats'); }} />}
      {tab === 'settings' && <SettingsPage />}
    </div>
  );
}
