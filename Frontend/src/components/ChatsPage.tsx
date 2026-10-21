import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as api from '../lib/api';
import { useAuth } from '../lib/auth';
import { useChat, useLiveQuery } from '../lib/chat';
import { fmtDay, fmtTime, sortMessages } from '../lib/format';
import { readScroll, saveScroll, usePersisted } from '../lib/persist';
import type { DialogDoc, MessageDoc, User } from '../types';
import { Avatar, useToast } from './ui';

export function ChatsPage() {
  const { session } = useAuth();
  const { db, presence, renamed, startDialog } = useChat();
  const toast = useToast();
  const [activeId, setActiveId] = usePersisted<string | null>('dialog', null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<User[] | null>(null);

  const dialogs = useLiveQuery<DialogDoc>((d) => d.dialogs.find(), []);
  const msgs = useLiveQuery<MessageDoc>((d) => d.messages.find({ selector: { isDeleted: false } }), []);

  const rows = useMemo(() => {
    const last = new Map<string, MessageDoc>();
    for (const m of msgs) { const c = last.get(m.dialogId); if (!c || sortMessages(c, m) < 0) last.set(m.dialogId, m); }
    return dialogs.map((d) => ({ d, last: last.get(d.id) }))
      .sort((a, b) => (b.last?.createdAt ?? b.d.createdAt) - (a.last?.createdAt ?? a.d.createdAt));
  }, [dialogs, msgs]);

  useEffect(() => {
    if (q.trim().length < 2) { setFound(null); return; }
    const t = setTimeout(() => {
      api.searchUsers(q.trim()).then((r) => setFound(r.filter((u) => u.id !== session!.user.id))).catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const open = async (u: User) => {
    try { setActiveId(await startDialog(u)); setQ(''); } catch (e) { toast((e as Error).message); }
  };

  const active = dialogs.find((d) => d.id === activeId);
  // диалог мог быть удалён собеседником — сбрасываем сохранённый выбор, когда БД уже загружена
  useEffect(() => {
    if (activeId && renamed[activeId]) setActiveId(renamed[activeId]); // диалог получил серверный id
    else if (db && activeId && dialogs.length && !active) setActiveId(null);
  }, [db, dialogs, activeId, renamed]);

  return (
    <div className={'main ' + (active ? 'open' : '')}>
      <aside className="side">
        <h3>Диалоги</h3>
        <input className="field" placeholder="Найти человека по логину или имени" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск пользователей" />
        <div className="list">
          {found ? (
            found.length ? found.map((u) => (
              <button key={u.id} className="row" onClick={() => open(u)}>
                <Avatar name={u.displayName} url={u.avatarUrl} online={presence[u.id] ?? false} />
                <div className="t"><div className="n">{u.displayName}</div><div className="m"><span>@{u.login}</span></div></div>
              </button>
            )) : <div className="empty">Никого не нашли. Попробуйте другой логин.</div>
          ) : rows.length ? rows.map(({ d, last }) => (
            <button key={d.id} className="row" aria-current={d.id === activeId} onClick={() => setActiveId(d.id)}>
              <Avatar name={d.peer.displayName} url={d.peer.avatarUrl} online={presence[d.peer.id] ?? false} />
              <div className="t">
                <div className="n">{d.peer.displayName}<small>{last ? fmtTime(last.createdAt) : ''}</small></div>
                <div className="m">
                  <span>{last ? (last.senderId === session!.user.id ? 'Вы: ' : '') + last.text : 'Новый диалог'}</span>
                  {d.unread > 0 && <b className="badge">{d.unread}</b>}
                </div>
              </div>
            </button>
          )) : <div className="empty">Пока пусто. Найдите человека в поиске выше.</div>}
        </div>
      </aside>
      <section className="chat">
        {active ? <ChatView key={active.id} dialog={active} onClose={() => setActiveId(null)} />
          : <div className="blank"><div><h2>Выберите диалог</h2><p>Или найдите собеседника в поиске слева.</p></div></div>}
      </section>
    </div>
  );
}

function ChatView({ dialog, onClose }: { dialog: DialogDoc; onClose: () => void }) {
  const { session } = useAuth();
  const { status, typing, presence, send, retry, remove, removeDialog, loadOlder, notifyTyping, setActive } = useChat();
  const toast = useToast();
  const me = session!.user.id;
  const raw = useLiveQuery<MessageDoc>((d) => d.messages.find({ selector: { dialogId: dialog.id } }), [dialog.id]);
  const msgs = useMemo(() => raw.filter((m) => !m.isDeleted).sort(sortMessages), [raw]);

  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true), first = useRef(true), busy = useRef(false), more = useRef(true);
  const anchor = useRef<number | null>(null), saveT = useRef<number>();
  const [confirm, setConfirm] = useState(false);
  const isTyping = !!typing[dialog.id];

  useEffect(() => { setActive(dialog.id); return () => setActive(null); }, [dialog.id]);

  // позиция в истории: восстановление, «прилипание» к низу, сохранение якоря при подгрузке вверх
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    if (anchor.current !== null) { el.scrollTop += el.scrollHeight - anchor.current; anchor.current = null; return; }
    if (first.current && msgs.length) {
      first.current = false;
      const s = readScroll(dialog.id);
      el.scrollTop = s && !s.bottom ? s.top : el.scrollHeight;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, isTyping]);

  const onScroll = () => {
    const el = box.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    clearTimeout(saveT.current);
    saveT.current = window.setTimeout(() => saveScroll(dialog.id, { top: el.scrollTop, bottom: stick.current }), 200);
    if (el.scrollTop < 80 && more.current && !busy.current && !first.current) {
      busy.current = true; anchor.current = el.scrollHeight;
      loadOlder(dialog.id)
        .then((n) => { if (n < 50) more.current = false; if (!n) anchor.current = null; })
        .catch(() => { anchor.current = null; })
        .finally(() => { busy.current = false; });
    }
  };

  const submit = () => {
    const t = ta.current!.value.trim(); if (!t) return;
    send(dialog.id, t.slice(0, 4000));
    ta.current!.value = ''; ta.current!.style.height = ''; stick.current = true;
  };
  const del = () => {
    if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; }
    removeDialog(dialog.id).then(() => { onClose(); toast('Диалог удалён у обоих участников'); }).catch((e) => toast(e.message));
  };

  let day = '';
  const items = msgs.map((m) => {
    const d = fmtDay(m.createdAt), sep = d !== day; day = d;
    const out = m.senderId === me;
    return (
      <div key={m.clientMessageId} style={{ display: 'contents' }}>
        {sep && <div className="day">{d}</div>}
        <div className={`msg ${out ? 'out' : 'in'} ${m.status}`}>
          {m.text}
          <span className="meta">
            {fmtTime(m.createdAt)}
            {out && (m.status === 'pending' ? ' · отправляется' : m.status === 'failed' ? ' · не отправлено' : ' · доставлено')}
          </span>
          {out && m.status === 'failed' && <button className="retry" onClick={() => retry(m)}>Повторить</button>}
          {out && <button className="x" aria-label="Удалить сообщение" onClick={() => remove(m).catch((e) => toast(e.message))}>×</button>}
        </div>
      </div>
    );
  });

  const peerOnline = presence[dialog.peer.id] ?? false;
  return (
    <>
      <div className="chead">
        <button className="ghost back" onClick={onClose} aria-label="К списку диалогов">←</button>
        <Avatar name={dialog.peer.displayName} url={dialog.peer.avatarUrl} online={peerOnline} />
        <div className="t">
          <div className="n">{dialog.peer.displayName}</div>
          <div className="s">{status !== 'online' ? 'нет соединения' : isTyping ? 'печатает…' : peerOnline ? 'в сети' : 'не в сети'}</div>
        </div>
        <button className="ghost" onClick={del}>{confirm ? 'Точно удалить?' : 'Удалить диалог'}</button>
      </div>
      <div className="msgs" ref={box} onScroll={onScroll}>
        {items.length ? items : <div className="empty" style={{ margin: 'auto' }}>Напишите первое сообщение.</div>}
        {isTyping && <div className="typing">печатает…</div>}
      </div>
      <div className="comp">
        <textarea ref={ta} rows={1} maxLength={4000} placeholder="Сообщение" aria-label="Сообщение"
          onChange={(e) => { e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = Math.min(e.currentTarget.scrollHeight, 140) + 'px'; notifyTyping(dialog.id); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        <button className="btn send" onClick={submit}>Отправить</button>
      </div>
    </>
  );
}
