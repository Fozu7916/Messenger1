import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../lib/api';
import { useAuth } from '../lib/auth';
import { useChat, useLiveQuery } from '../lib/chat';
import { fmtDay, fmtTime, sortMessages } from '../lib/format';
import { readScroll, saveScroll, usePersisted } from '../lib/persist';
import type { DialogDoc, MessageDoc, User } from '../types';
import { Avatar, useToast } from './ui';

const PAGE = 30;

const Pencil = () => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" /></svg>;
const Trash = () => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" /></svg>;

/** Окно подтверждения удаления (как в Telegram): Esc/клик мимо — отмена, Enter — подтвердить. */
function ConfirmModal({ title, children, checkLabel, confirmLabel = 'Удалить', onCancel, onConfirm }: {
  title: string; children: ReactNode; checkLabel?: string; confirmLabel?: string;
  onCancel: () => void; onConfirm: (checked: boolean) => void;
}) {
  const [checked, setChecked] = useState(false);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ok.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h3 id="modal-title">{title}</h3>
        <div className="modal-body">{children}</div>
        {checkLabel && (
          <label className="check modal-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>{checkLabel}</span>
          </label>
        )}
        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>Отмена</button>
          <button ref={ok} className="danger" onClick={() => onConfirm(checked)}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
interface Hit { key: string; id: string; dialogId: string; senderId: string; text: string; createdAt: number }

export function ChatsPage() {
  const { session } = useAuth();
  const { db, presence, renamed, startDialog } = useChat();
  const toast = useToast();
  const [activeId, setActiveId] = usePersisted<string | null>('dialog', null);
  const [view, setView] = usePersisted<'dialogs' | 'people'>('chatsView', 'dialogs');
  const [q, setQ] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null); // сообщение, к которому прокрутить после поиска
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [people, setPeople] = useState<User[]>([]);
  const [peopleMore, setPeopleMore] = useState(false);
  const [peopleBusy, setPeopleBusy] = useState(false);
  const [peopleErr, setPeopleErr] = useState('');

  const dialogs = useLiveQuery<DialogDoc>((d) => d.dialogs.find(), []);
  const msgs = useLiveQuery<MessageDoc>((d) => d.messages.find({ selector: { isDeleted: false } }), []);

  const rows = useMemo(() => {
    const last = new Map<string, MessageDoc>();
    for (const m of msgs) { const c = last.get(m.dialogId); if (!c || sortMessages(c, m) < 0) last.set(m.dialogId, m); }
    return dialogs.map((d) => ({ d, last: last.get(d.id) }))
      .sort((a, b) => (b.last?.createdAt ?? b.d.createdAt) - (a.last?.createdAt ?? a.d.createdAt));
  }, [dialogs, msgs]);

  const term = q.trim().toLowerCase();
  const shownRows = useMemo(() => !term ? rows : rows.filter(({ d }) =>
    d.peer.displayName.toLowerCase().includes(term) || d.peer.login.toLowerCase().includes(term)), [rows, term]);
  const contacts = useMemo(() => new Set(dialogs.map((d) => d.peer.id)), [dialogs]);

  // Поиск по сообщениям: на сервере (вся история); без сети — по тому, что есть на устройстве
  useEffect(() => {
    if (view !== 'dialogs' || term.length < 2) { setHits(null); return; }
    let stale = false;
    const t = setTimeout(async () => {
      let list: Hit[];
      try {
        list = (await api.searchMessages(q.trim(), { limit: 30 })).map((m) => ({
          key: m.id, id: m.id, dialogId: m.dialogId, senderId: m.senderId, text: m.text, createdAt: Date.parse(m.createdAt),
        }));
      } catch {
        list = msgs.filter((m) => m.text.toLowerCase().includes(term))
          .sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)
          .map((m) => ({ key: m.clientMessageId, id: m.id, dialogId: m.dialogId, senderId: m.senderId, text: m.text, createdAt: m.createdAt }));
      }
      if (!stale) setHits(list);
    }, 300);
    return () => { stale = true; clearTimeout(t); };
  }, [q, view]);

  // Люди: без запроса — все пользователи, с запросом — поиск по логину и имени
  useEffect(() => {
    if (view !== 'people') return;
    let stale = false;
    setPeopleBusy(true); setPeopleErr('');
    const t = setTimeout(() => {
      api.users({ query: q.trim(), limit: PAGE })
        .then((r) => { if (!stale) { setPeople(r); setPeopleMore(r.length === PAGE); } })
        .catch((e: Error) => { if (!stale) { setPeople([]); setPeopleMore(false); setPeopleErr(e.message); } })
        .finally(() => { if (!stale) setPeopleBusy(false); });
    }, q ? 250 : 0);
    return () => { stale = true; clearTimeout(t); };
  }, [view, q]);

  const morePeople = () => {
    setPeopleBusy(true);
    api.users({ query: q.trim(), offset: people.length, limit: PAGE })
      .then((r) => {
        setPeople((p) => [...p, ...r.filter((u) => !p.some((x) => x.id === u.id))]);
        setPeopleMore(r.length === PAGE);
      })
      .catch((e: Error) => toast(e.message))
      .finally(() => setPeopleBusy(false));
  };

  const open = async (u: User) => {
    try { setFocusId(null); setActiveId(await startDialog(u)); setView('dialogs'); setQ(''); } catch (e) { toast((e as Error).message); }
  };
  const pick = (id: string, focus: string | null = null) => { setFocusId(focus); setActiveId(id); };

  const active = dialogs.find((d) => d.id === activeId);
  // диалог мог быть удалён собеседником — сбрасываем сохранённый выбор, когда БД уже загружена
  useEffect(() => {
    if (activeId && renamed[activeId]) setActiveId(renamed[activeId]); // диалог получил серверный id
    else if (db && activeId && dialogs.length && !active) setActiveId(null);
  }, [db, dialogs, activeId, renamed]);

  const me = session!.user.id;
  const peerOf = (dialogId: string) => dialogs.find((d) => d.id === dialogId)?.peer;

  return (
    <div className={'main ' + (active ? 'open' : '')}>
      <aside className="side">
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={view === 'dialogs'} onClick={() => setView('dialogs')}>Диалоги</button>
          <button role="tab" aria-selected={view === 'people'} onClick={() => setView('people')}>Люди</button>
        </div>
        <input className="field" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={view === 'people' ? 'Имя или логин' : 'Поиск по диалогам и сообщениям'}
          aria-label={view === 'people' ? 'Поиск людей' : 'Поиск по диалогам и сообщениям'} />
        <div className="list">
          {view === 'people' ? (
            <>
              {people.map((u) => (
                <button key={u.id} className="row" onClick={() => open(u)}>
                  <Avatar name={u.displayName} url={u.avatarUrl} online={contacts.has(u.id) ? presence[u.id] ?? false : undefined} />
                  <div className="t"><div className="n">{u.displayName}</div><div className="m"><span>@{u.login}</span></div></div>
                </button>
              ))}
              {peopleErr && <div className="empty">{peopleErr}</div>}
              {!peopleBusy && !peopleErr && !people.length && <div className="empty">{q ? 'Никого не нашли. Попробуйте другое имя или логин.' : 'Пока здесь никого нет.'}</div>}
              {peopleBusy && <div className="empty">Загружаем…</div>}
              {peopleMore && !peopleBusy && <button className="ghost more" onClick={morePeople}>Показать ещё</button>}
            </>
          ) : (
            <>
              {term && <div className="sect">Диалоги</div>}
              {shownRows.map(({ d, last }) => (
                <button key={d.id} className="row" aria-current={d.id === activeId} onClick={() => pick(d.id)}>
                  <Avatar name={d.peer.displayName} url={d.peer.avatarUrl} online={presence[d.peer.id] ?? false} />
                  <div className="t">
                    <div className="n">{d.peer.displayName}<small>{last ? fmtTime(last.createdAt) : ''}</small></div>
                    <div className="m">
                      <span>{last ? (last.senderId === me ? 'Вы: ' : '') + last.text : 'Новый диалог'}</span>
                      {d.unread > 0 && <b className="badge">{d.unread}</b>}
                    </div>
                  </div>
                </button>
              ))}
              {!shownRows.length && !term && <div className="empty">Пока пусто. Откройте вкладку «Люди» и выберите собеседника.</div>}
              {!shownRows.length && term && <div className="empty">Диалогов с таким именем нет.</div>}
              {term && hits && (
                <>
                  <div className="sect">Сообщения</div>
                  {hits.filter((h) => peerOf(h.dialogId)).map((h) => {
                    const peer = peerOf(h.dialogId)!;
                    return (
                      <button key={h.key} className="row" onClick={() => pick(h.dialogId, h.id || null)}>
                        <Avatar name={peer.displayName} url={peer.avatarUrl} />
                        <div className="t">
                          <div className="n">{peer.displayName}<small>{fmtDay(h.createdAt)}</small></div>
                          <div className="m"><span>{(h.senderId === me ? 'Вы: ' : '') + h.text}</span></div>
                        </div>
                      </button>
                    );
                  })}
                  {!hits.some((h) => peerOf(h.dialogId)) && <div className="empty">В сообщениях ничего не нашли.</div>}
                </>
              )}
              {term && <button className="ghost more" onClick={() => setView('people')}>Искать «{q.trim()}» среди всех людей</button>}
            </>
          )}
        </div>
      </aside>
      <section className="chat">
        {active ? <ChatView key={active.id} dialog={active} focusId={focusId} onClose={() => setActiveId(null)} />
          : <div className="blank"><div><div className="blank-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 016.5 3h11A2.5 2.5 0 0120 5.5v8a2.5 2.5 0 01-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 014 13.5v-8z" /></svg></div><h2>Выберите диалог</h2><p>Или найдите собеседника на вкладке «Люди».</p></div></div>}
      </section>
    </div>
  );
}

function ChatView({ dialog, focusId, onClose }: { dialog: DialogDoc; focusId: string | null; onClose: () => void }) {
  const { session } = useAuth();
  const { status, typing, presence, send, retry, remove, edit, removeDialog, loadOlder, notifyTyping, setActive } = useChat();
  const toast = useToast();
  const me = session!.user.id;
  const raw = useLiveQuery<MessageDoc>((d) => d.messages.find({ selector: { dialogId: dialog.id } }), [dialog.id]);
  const msgs = useMemo(() => raw.filter((m) => !m.isDeleted).sort(sortMessages), [raw]);

  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true), first = useRef(true), busy = useRef(false), more = useRef(true), focused = useRef(false);
  const anchor = useRef<number | null>(null), saveT = useRef<number>();
  const [delMsg, setDelMsg] = useState<MessageDoc | null>(null);   // сообщение, ожидающее подтверждения удаления
  const [delDialog, setDelDialog] = useState(false);
  const [editing, setEditing] = useState<MessageDoc | null>(null);
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

  // переход к найденному сообщению (если оно уже есть на устройстве)
  useEffect(() => {
    if (!focusId || focused.current) return;
    const el = document.getElementById('m-' + focusId);
    if (!el) return;
    focused.current = true; stick.current = false;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1800);
  }, [focusId, msgs]);

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

  const resize = () => { const el = ta.current!; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 140) + 'px'; };
  const startEdit = (m: MessageDoc) => { setEditing(m); const el = ta.current!; el.value = m.text; resize(); el.focus(); };
  const cancelEdit = () => { setEditing(null); const el = ta.current!; el.value = ''; el.style.height = ''; };

  const submit = () => {
    const t = ta.current!.value.trim(); if (!t) return;
    if (editing) {
      edit(editing, t.slice(0, 4000)).then(cancelEdit).catch((e: Error) => toast(e.message));
      return;
    }
    send(dialog.id, t.slice(0, 4000));
    ta.current!.value = ''; ta.current!.style.height = ''; stick.current = true;
  };
  const delDialogNow = () => {
    setDelDialog(false);
    removeDialog(dialog.id).then(() => { onClose(); toast('Диалог удалён у обоих участников'); }).catch((e) => toast(e.message));
  };
  // Неотправленное сообщение убираем сразу (на сервере его нет), остальные — через подтверждение
  const askDelete = (m: MessageDoc) => {
    if (!m.id) remove(m, 'me').catch((e) => toast(e.message));
    else setDelMsg(m);
  };
  const delMsgNow = (forAll: boolean) => {
    const m = delMsg!; setDelMsg(null);
    remove(m, forAll ? 'all' : 'me').catch((e) => toast(e.message));
  };

  let day = '';
  const items = msgs.map((m) => {
    const d = fmtDay(m.createdAt), sep = d !== day; day = d;
    const out = m.senderId === me;
    const state = m.status === 'pending' ? ' · отправляется' : m.status === 'failed' ? ' · не отправлено'
      : m.id && dialog.peerRead >= m.id ? ' · прочитано' : ' · доставлено';
    return (
      <div key={m.clientMessageId} style={{ display: 'contents' }}>
        {sep && <div className="day">{d}</div>}
        <div id={m.id ? 'm-' + m.id : undefined} className={`msg ${out ? 'out' : 'in'} ${m.status}`}>
          {m.text}
          <span className="meta">
            {fmtTime(m.createdAt)}
            {m.editedAt > 0 && ' · изменено'}
            {out && state}
          </span>
          {out && m.status === 'failed' && <button className="retry" onClick={() => retry(m)}>Повторить</button>}
          {out && m.status !== 'failed' && <button className="x ed" aria-label="Изменить сообщение" title="Изменить" onClick={() => startEdit(m)}><Pencil /></button>}
          <button className="x del" aria-label="Удалить сообщение" title="Удалить" onClick={() => askDelete(m)}><Trash /></button>
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
          <div className={'s ' + (status !== 'online' ? '' : isTyping ? 'typing' : peerOnline ? 'on' : '')}>{status !== 'online' ? 'нет соединения' : isTyping ? 'печатает…' : peerOnline ? 'в сети' : 'не в сети'}</div>
        </div>
        <button className="ghost" onClick={() => setDelDialog(true)}>Удалить диалог</button>
      </div>
      <div className="msgs" ref={box} onScroll={onScroll}>
        {items.length ? items : <div className="empty" style={{ margin: 'auto' }}>Напишите первое сообщение.</div>}
        {isTyping && <div className="typing" aria-label="печатает"><i /><i /><i /></div>}
      </div>
      {editing && (
        <div className="editbar">
          <span>Редактирование · <i>{editing.text.length > 60 ? editing.text.slice(0, 60) + '…' : editing.text}</i></span>
          <button className="ghost" onClick={cancelEdit}>Отмена</button>
        </div>
      )}
      <div className="comp">
        <textarea ref={ta} rows={1} maxLength={4000} placeholder={editing ? 'Новый текст сообщения' : 'Сообщение'} aria-label="Сообщение"
          onChange={() => { resize(); if (!editing) notifyTyping(dialog.id); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            else if (e.key === 'Escape' && editing) cancelEdit();
          }} />
        <button className="send" onClick={submit} aria-label={editing ? 'Сохранить' : 'Отправить'} title={editing ? 'Сохранить' : 'Отправить'}>
          {editing
            ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12L20 4l-5 16-3.5-6.5L4 12z" /></svg>}
        </button>
      </div>
      {delMsg && (
        <ConfirmModal title="Удалить сообщение?" checkLabel={`Также удалить для ${dialog.peer.displayName}`}
          onCancel={() => setDelMsg(null)} onConfirm={delMsgNow}>
          <blockquote className="modal-quote">{delMsg.text}</blockquote>
        </ConfirmModal>
      )}
      {delDialog && (
        <ConfirmModal title="Удалить диалог?" confirmLabel="Удалить диалог" onCancel={() => setDelDialog(false)} onConfirm={delDialogNow}>
          Вся переписка с {dialog.peer.displayName} будет удалена у обоих участников. Это нельзя отменить.
        </ConfirmModal>
      )}
    </>
  );
}
