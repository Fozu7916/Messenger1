import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { useChat, type ConnStatus } from './chat';
import type { User } from './types';

export function Avatar({ u, size = 40 }: { u: User | null; size?: number }) {
  const ok = !!u?.avatarUrl && /^https?:\/\//i.test(u.avatarUrl);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {ok ? <img src={u!.avatarUrl!} alt="" referrerPolicy="no-referrer" /> : (u?.displayName || u?.login || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

export const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

const STATUS: Record<ConnStatus, string> = {
  connecting: 'Подключение…',
  online: 'Соединение защищено',
  reconnecting: 'Переподключение…',
  offline: 'Нет связи, работаем офлайн',
};

export function Sidebar() {
  const c = useChat();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<User[]>([]);
  const [profile, setProfile] = useState(false);
  const searching = q.trim().length >= 2;

  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setFound([]); return; }
    let stale = false;
    const t = setTimeout(() => api.search(s).then((r) => !stale && setFound(r)).catch(() => !stale && setFound([])), 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);

  async function pick(u: User) {
    await c.startDialog(u.id);
    setQ('');
  }

  return (
    <aside className="side">
      <header className="bar">
        <button className="me" onClick={() => setProfile(true)} title="Профиль">
          <Avatar u={c.me} size={36} />
          <span>{c.me.displayName}</span>
        </button>
        <button className="btn sm" onClick={() => void c.logout()}>Выйти</button>
      </header>

      <div className="search">
        <input className="input" placeholder="Найти человека по логину или имени" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <p className="stamp label">{searching ? 'Результаты' : 'Диалоги'}</p>
      <ul className="list">
        {searching && found.map((u) => (
          <li key={u.id}>
            <button className="row" onClick={() => void pick(u)}>
              <Avatar u={u} />
              <span className="grow"><b>{u.displayName}</b><small className="muted">@{u.login}</small></span>
              <span className="cap">Написать</span>
            </button>
          </li>
        ))}
        {searching && !found.length && <li className="note">Никого не нашли. Поиск идёт по началу логина или имени.</li>}
        {!searching && c.dialogs.map((d) => (
          <li key={d.id}>
            <button className="row" data-active={d.id === c.activeId} onClick={() => c.open(d.id)}>
              <span className="avwrap">
                <Avatar u={d.peer} />
                {d.peer && c.online[d.peer.id] && <i className="dot" />}
              </span>
              <span className="grow">
                <b>{d.peer?.displayName ?? 'Диалог'}</b>
                <small className="muted clip">{c.typing[d.id] ? 'печатает…' : d.lastMessage?.text ?? 'Сообщений пока нет'}</small>
              </span>
              {d.lastMessage && <span className="cap">{time(d.lastMessage.createdAt)}</span>}
            </button>
          </li>
        ))}
        {!searching && !c.dialogs.length && <li className="note">Диалогов пока нет. Найдите человека в поиске, чтобы начать переписку.</li>}
      </ul>

      <footer className="foot">
        <span>+&nbsp; {STATUS[c.status]}</span>
        <i className="dot" data-on={c.status === 'online'} />
      </footer>

      {profile && <Profile onClose={() => setProfile(false)} />}
    </aside>
  );
}

function Profile({ onClose }: { onClose(): void }) {
  const { me, updateProfile } = useChat();
  const [name, setName] = useState(me.displayName);
  const [url, setUrl] = useState(me.avatarUrl ?? '');
  const [err, setErr] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    const a = url.trim();
    if (a && !/^https?:\/\//i.test(a)) return setErr('Ссылка на аватар должна начинаться с http:// или https://');
    try { await updateProfile(name.trim(), a || null); onClose(); }
    catch (x) { setErr(x instanceof Error ? x.message : 'Не удалось сохранить'); }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <form className="pass modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="pass-top"><span className="cap">Профиль</span><span className="cap">@{me.login}</span></div>
        <label><span className="cap">Имя в чате</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required /></label>
        <label><span className="cap">Ссылка на аватар</span>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="actions">
          <button type="button" className="btn pill ghost" onClick={onClose}>Отмена</button>
          <button className="btn primary">Сохранить</button>
        </div>
      </form>
    </div>
  );
}
