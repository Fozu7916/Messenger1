import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import { useAuth } from '../lib/auth';
import { useChat } from '../lib/chat';
import type { DialogDoc, User } from '../types';
import { Modal } from './modals';
import { Avatar, useToast } from './ui';

/** Поиск людей для выбора: без запроса — все по алфавиту, с запросом — поиск по частям. exclude — кого не показывать. */
function UserPicker({ exclude, onPick }: { exclude: Set<string>; onPick: (u: User) => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<User[]>([]);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let stale = false;
    setBusy(true);
    const t = setTimeout(() => {
      (q.trim() ? api.searchUsers(q.trim(), { limit: 20 }) : api.users({ limit: 20 }))
        .then((r) => { if (!stale) setList(r); }).catch(() => { if (!stale) setList([]); }).finally(() => { if (!stale) setBusy(false); });
    }, q ? 250 : 0);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);
  const shown = list.filter((u) => !exclude.has(u.id));
  return (
    <div>
      <input className="field search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя или логин" aria-label="Поиск людей" />
      <div className="fwd-list">
        {shown.map((u) => (
          <button key={u.id} type="button" className="row" onClick={() => onPick(u)}>
            <Avatar name={u.displayName} url={u.avatarUrl} size={40} />
            <div className="t"><div className="n">{u.displayName}</div><div className="m"><span>@{u.login}</span></div></div>
          </button>
        ))}
        {!busy && !shown.length && <div className="empty">Никого не нашли.</div>}
      </div>
    </div>
  );
}

/** Новая беседа: название и участники (до 49 человек). */
export function NewGroupModal({ onClose, onCreated }: { onClose: () => void; onCreated: (dialogId: string) => void }) {
  const { createGroup } = useChat();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const ok = title.trim().length > 0 && picked.length > 0;
  const create = async () => {
    setBusy(true);
    try { onCreated(await createGroup(title.trim(), picked.map((u) => u.id))); }
    catch (e) { toast((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Новая беседа" onClose={onClose}>
      <input className="field" autoFocus value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Название беседы" aria-label="Название беседы" />
      {picked.length > 0 && (
        <div className="chips">
          {picked.map((u) => (
            <button key={u.id} type="button" className="chip rm" onClick={() => setPicked((p) => p.filter((x) => x.id !== u.id))} title="Убрать">{u.displayName} ✕</button>
          ))}
        </div>
      )}
      <div className="stitle pickh">Участники{picked.length ? `: ${picked.length}` : ''}</div>
      <UserPicker exclude={new Set(picked.map((u) => u.id))} onPick={(u) => setPicked((p) => (p.length >= 49 ? p : [...p, u]))} />
      <button className="btn big wide" disabled={!ok || busy} onClick={() => void create()}>{busy ? 'Создаём…' : 'Создать беседу'}</button>
    </Modal>
  );
}

const plural = (n: number, f: [string, string, string]) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? f[0] : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? f[1] : f[2]}`;
export const membersLabel = (n: number) => plural(n, ['участник', 'участника', 'участников']);

/** Сведения о беседе: название, аватар, участники, добавление, исключение, выход. */
export function GroupInfo({ dialog, onClose, onLeft }: { dialog: DialogDoc; onClose: () => void; onLeft: () => void }) {
  const { session } = useAuth();
  const { members, loadMembers, resync, removeDialog } = useChat();
  const toast = useToast();
  const me = session!.user.id;
  const list = members[dialog.id] ?? [];
  const owner = dialog.myRole === 'owner';
  const [title, setTitle] = useState(dialog.peer.displayName);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { loadMembers(dialog.id).catch((e: Error) => toast(e.message)); }, [dialog.id]);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); await resync(); await loadMembers(dialog.id); if (done) toast(done); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const pickAvatar = (f?: File) => {
    if (file.current) file.current.value = '';
    if (f) void run(() => api.uploadGroupAvatar(dialog.id, f), 'Фото беседы обновлено');
  };
  return (
    <Modal title="Беседа" onClose={onClose}>
      <div className="pcard">
        <Avatar name={dialog.peer.displayName} url={dialog.peer.avatarUrl} size={96} />
        <div className="hint">{membersLabel(list.length || dialog.memberCount)}</div>
        <div className="actions left avedit">
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => pickAvatar(e.target.files?.[0])} />
          <button className="ghost" disabled={busy} onClick={() => file.current?.click()}>Сменить фото</button>
          {dialog.peer.avatarUrl && <button className="ghost" disabled={busy} onClick={() => void run(() => api.deleteGroupAvatar(dialog.id))}>Удалить</button>}
        </div>
      </div>
      {owner && (
        <div className="findrow titlerow">
          <input className="field" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} aria-label="Название беседы" />
          <button className="ghost" disabled={busy || !title.trim() || title.trim() === dialog.peer.displayName} onClick={() => void run(() => api.renameGroup(dialog.id, title.trim()), 'Название изменено')}>Сохранить</button>
        </div>
      )}
      <div className="stitle pickh">Участники</div>
      <div className="fwd-list members">
        {list.map(({ user, role }) => (
          <div key={user.id} className="row">
            <Avatar name={user.displayName} url={user.avatarUrl} size={40} />
            <div className="t"><div className="n">{user.displayName}{user.id === me && ' (вы)'}</div><div className="m"><span>@{user.login}</span>{role === 'owner' && <span className="tag">создатель</span>}</div></div>
            {owner && user.id !== me && (
              <button className="icbtn" aria-label={`Исключить ${user.displayName}`} title="Исключить" disabled={busy}
                onClick={() => void run(() => api.removeMember(dialog.id, user.id))}>✕</button>
            )}
          </div>
        ))}
      </div>
      {adding
        ? <UserPicker exclude={new Set(list.map((m) => m.user.id))} onPick={(u) => void run(() => api.addMembers(dialog.id, [u.id]), `Добавлен(а): ${u.displayName}`)} />
        : <button className="ghost" disabled={busy || list.length >= 50} onClick={() => setAdding(true)}>Добавить участников</button>}
      <div className="actions left">
        <button className="danger" disabled={busy} onClick={() => { void removeDialog(dialog.id).then(onLeft).catch((e: Error) => toast(e.message)); }}>
          {owner ? 'Удалить беседу для всех' : 'Выйти из беседы'}
        </button>
      </div>
    </Modal>
  );
}
