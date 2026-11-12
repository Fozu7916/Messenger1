import { useEffect, useMemo, useState } from 'react';
import * as api from '../lib/api';
import { useChat, useLiveQuery } from '../lib/chat';
import type { DialogDoc, User } from '../types';
import { PeerProfile } from './modals';
import { Avatar, useToast } from './ui';

const PAGE = 30;

/** Люди: все пользователи постранично (по 30), поиск по частям в логине и имени. Клик — профиль и кнопка «Написать». */
export function PeoplePage({ initialQuery, onOpenDialog }: { initialQuery: string; onOpenDialog: (dialogId: string) => void }) {
  const { presence, startDialog } = useChat();
  const toast = useToast();
  const [q, setQ] = useState(initialQuery);
  const [people, setPeople] = useState<User[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<User | null>(null);
  const dialogs = useLiveQuery<DialogDoc>((d) => d.dialogs.find(), []);
  const contacts = useMemo(() => new Set(dialogs.map((d) => d.peer.id)), [dialogs]);
  const term = q.trim();
  const fetchPage = (offset: number) => term
    ? api.searchUsers(term, { limit: PAGE, offset })
    : api.users({ limit: PAGE, offset });
  useEffect(() => {
    let stale = false;
    setBusy(true); setErr('');
    const t = setTimeout(() => {
      fetchPage(0)
        .then((r) => { if (!stale) { setPeople(r); setMore(r.length === PAGE); } })
        .catch((e: Error) => { if (!stale) { setPeople([]); setMore(false); setErr(e.message); } })
        .finally(() => { if (!stale) setBusy(false); });
    }, term ? 250 : 0);
    return () => { stale = true; clearTimeout(t); };
  }, [term]);
  const loadMore = () => {
    setBusy(true);
    fetchPage(people.length)
      .then((r) => {
        setPeople((p) => [...p, ...r.filter((u) => !p.some((x) => x.id === u.id))]);
        setMore(r.length === PAGE);
      })
      .catch((e: Error) => toast(e.message))
      .finally(() => setBusy(false));
  };
  const write = async (u: User) => {
    try { onOpenDialog(await startDialog(u)); } catch (e) { toast((e as Error).message); }
  };
  return (
    <section className="people">
      <header className="phead">
        <h2>Люди</h2>
        <p>Найдите собеседника по имени или логину — слова можно писать в любом порядке.</p>
        <input className="field search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя или логин" aria-label="Поиск людей" autoFocus />
      </header>
      <div className="plist">
        {people.map((u) => (
          <button key={u.id} className="row" onClick={() => setSel(u)}>
            <Avatar name={u.displayName} url={u.avatarUrl} online={contacts.has(u.id) ? presence[u.id] ?? false : undefined} size={46} />
            <div className="t">
              <div className="n">{u.displayName}</div>
              <div className="m"><span>@{u.login}</span>{contacts.has(u.id) && <span className="tag">в чатах</span>}</div>
            </div>
          </button>
        ))}
        {err && <div className="empty">{err}</div>}
        {!busy && !err && !people.length && <div className="empty">{term ? 'Никого не нашли. Попробуйте другое имя или логин.' : 'Пока здесь никого нет.'}</div>}
        {busy && <div className="empty">Загружаем…</div>}
        {more && !busy && <button className="ghost more" onClick={loadMore}>Показать ещё</button>}
      </div>
      {sel && <PeerProfile peer={sel} online={contacts.has(sel.id) ? presence[sel.id] ?? false : undefined}
        action={{ label: 'Написать', onClick: () => { const u = sel; setSel(null); void write(u); } }} onClose={() => setSel(null)} />}
    </section>
  );
}
