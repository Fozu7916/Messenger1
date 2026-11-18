import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type ReactNode, type TouchEvent as RTouchEvent } from 'react';
import * as api from '../lib/api';
import { useAuth } from '../lib/auth';
import { previewOf, useChat, useLiveQuery } from '../lib/chat';
import { fmtDay, fmtLastSeen, fmtTime, matchesAll, sortMessages } from '../lib/format';
import { canRecord, useVoiceRecorder } from '../lib/media';
import { readScroll, saveScroll, usePersisted } from '../lib/persist';
import type { DialogDoc, MessageDoc } from '../types';
import { GroupInfo, NewGroupModal, membersLabel } from './GroupModals';
import { fmtDuration, ImageBubble, Lightbox, VoicePlayer } from './MediaBits';
import { PeerProfile, Modal } from './modals';
import { Avatar, useToast } from './ui';

const Plus = () => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
const Clip = () => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5l-7.8 7.8a5 5 0 01-7-7l8.2-8.2a3.3 3.3 0 014.7 4.7L10 17a1.7 1.7 0 01-2.4-2.4l7-7" /></svg>;
const Mic = () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" /></svg>;
const hue = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return String(h % 360); };
const Search = () => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;
const Trash = () => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" /></svg>;
const Dots = () => <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" /></svg>;

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* нет доступа к буферу — пробуем запасной путь */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
}

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

interface MenuItem { label: string; danger?: boolean; onClick: () => void }
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
interface Picker { current?: string; onPick: (emoji: string | null) => void }

/** Контекстное меню сообщения (ПКМ, долгое нажатие или кнопка «⋯»): стрелки и Esc, закрывается при прокрутке и клике мимо. */
function ContextMenu({ x, y, items, picker, onClose }: { x: number; y: number; items: MenuItem[]; picker?: Picker; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const buttons = () => Array.from(ref.current?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
    buttons()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = buttons(), i = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    document.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      document.removeEventListener('scroll', onClose, true);
    };
  }, []);
  return createPortal(
    <div className="ctx-back" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div ref={ref} className="ctx" role="menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
        {picker && (
          <div className="rpick" role="group" aria-label="Реакция">
            {REACTIONS.map((e) => (
              <button key={e} role="menuitem" aria-pressed={picker.current === e} className={picker.current === e ? 'on' : ''}
                onClick={() => { onClose(); picker.onPick(picker.current === e ? null : e); }}>{e}</button>
            ))}
          </div>
        )}
        {items.map((it) => (
          <button key={it.label} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { onClose(); it.onClick(); }}>{it.label}</button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** Выбор диалога для пересылки. */
function ForwardModal({ msg, onClose, onDone }: { msg: MessageDoc; onClose: () => void; onDone: () => void }) {
  const { forward } = useChat();
  const toast = useToast();
  const dialogs = useLiveQuery<DialogDoc>((d) => d.dialogs.find(), []);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = dialogs.filter((d) => matchesAll(`${d.peer.displayName} ${d.peer.login}`, q));
  const pick = (d: DialogDoc) => {
    setBusy(true);
    forward([msg], d.id)
      .then(() => { toast(`Переслано: ${d.peer.displayName}`); onDone(); })
      .catch((e: Error) => { toast(e.message); setBusy(false); });
  };
  return (
    <Modal title="Переслать сообщение" onClose={onClose}>
      <blockquote className="modal-quote">{msg.text.length > 140 ? msg.text.slice(0, 140) + '…' : msg.text}</blockquote>
      <input className="field" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Кому переслать" aria-label="Поиск собеседника" />
      <div className="fwd-list">
        {shown.map((d) => (
          <button key={d.id} className="row" disabled={busy} onClick={() => pick(d)}>
            <Avatar name={d.peer.displayName} url={d.peer.avatarUrl} />
            <div className="t"><div className="n">{d.peer.displayName}</div><div className="m"><span>{d.kind === 'group' ? 'Беседа' : '@' + d.peer.login}</span></div></div>
          </button>
        ))}
        {!shown.length && <div className="empty">Диалогов не найдено.</div>}
      </div>
    </Modal>
  );
}

const ACT_W = 88;
/** Строка списка со свайпом влево: открывает красную кнопку действия (на сенсорных экранах). */
function SwipeRow({ label, onAction, children }: { label: string; onAction: () => void; children: ReactNode }) {
  const [x, setX] = useState(0);
  const [drag, setDrag] = useState(false);
  const st = useRef<{ x: number; y: number; base: number; lock: boolean } | null>(null);
  const end = () => {
    const s0 = st.current; st.current = null;
    if (!s0?.lock) return;
    setDrag(false); setX((v) => (v < -ACT_W / 2 ? -ACT_W : 0));
  };
  return (
    <div className="swrow">
      <button className={'swact' + (x < 0 || drag ? ' on' : '')} tabIndex={x < 0 ? 0 : -1} onClick={() => { setX(0); onAction(); }}>{label}</button>
      <div className="swin" style={{ transform: `translateX(${x}px)`, transition: drag ? 'none' : 'transform .2s ease-out' }}
        onTouchStart={(e) => { const t = e.touches[0]; st.current = { x: t.clientX, y: t.clientY, base: x, lock: false }; }}
        onTouchMove={(e) => {
          const s0 = st.current;
          if (!s0) return;
          const t = e.touches[0], dx = t.clientX - s0.x, dy = t.clientY - s0.y;
          if (!s0.lock) {
            if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { st.current = null; return; }   // это прокрутка списка
            if (Math.abs(dx) > 10) { s0.lock = true; setDrag(true); } else return;
          }
          setX(Math.min(0, Math.max(-ACT_W, s0.base + dx)));
        }}
        onTouchEnd={end} onTouchCancel={end}
        onClickCapture={(e) => { if (x !== 0) { e.preventDefault(); e.stopPropagation(); setX(0); } }}>
        {children}
      </div>
    </div>
  );
}

const EMOJI = ['😀', '😂', '🥹', '😍', '🥰', '😘', '😎', '🤔', '😅', '😭', '😡', '🥳', '😴', '🤯', '😬', '🙄',
  '👍', '👎', '👏', '🙏', '💪', '🤝', '👀', '🔥', '❤️', '💔', '✨', '🎉', '💯', '✅', '❌', '⚡',
  '🌟', '☕', '🍕', '🎮', '🎧', '📷', '💻', '🚀', '🐱', '🐶', '😺', '🌈', '🍀', '🎂', '🏆', '🫶'];

/** Всплывающая панель эмодзи у кнопки в поле ввода. Закрывается по клику вне панели и по Esc. */
function EmojiPop({ anchor, onPick, onClose }: { anchor: DOMRect; onPick: (e: string) => void; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);
  return createPortal(
    <div className="emo-back" onMouseDown={onClose}>
      <div className="emopop" role="dialog" aria-label="Эмодзи" onMouseDown={(e) => e.stopPropagation()}
        style={{ right: Math.max(8, window.innerWidth - anchor.right), bottom: window.innerHeight - anchor.top + 8 }}>
        {EMOJI.map((e) => <button key={e} onClick={() => onPick(e)}>{e}</button>)}
      </div>
    </div>,
    document.body,
  );
}

interface Hit { key: string; id: string; senderId: string; text: string; createdAt: number }

/** «Чаты»: список диалогов с поиском по имени или логину собеседника. Поиск по тексту — внутри самого чата (лупа в шапке). */
export function ChatsPage({ onFindPeople }: { onFindPeople: (q: string) => void }) {
  const { session } = useAuth();
  const { db, presence, renamed, removeDialog } = useChat();
  const toast = useToast();
  const [delRow, setDelRow] = useState<DialogDoc | null>(null);
  const [activeId, setActiveId] = usePersisted<string | null>('dialog', null);
  const [q, setQ] = useState('');
  const [newGroup, setNewGroup] = useState(false);
  const dialogs = useLiveQuery<DialogDoc>((d) => d.dialogs.find(), []);
  const msgs = useLiveQuery<MessageDoc>((d) => d.messages.find({ selector: { isDeleted: false } }), []);
  const rows = useMemo(() => {
    const last = new Map<string, MessageDoc>();
    for (const m of msgs) { const c = last.get(m.dialogId); if (!c || sortMessages(c, m) < 0) last.set(m.dialogId, m); }
    return dialogs.map((d) => ({ d, last: last.get(d.id) }))
      .sort((a, b) => (b.last?.createdAt ?? b.d.createdAt) - (a.last?.createdAt ?? a.d.createdAt));
  }, [dialogs, msgs]);
  const term = q.trim();
  const shownRows = useMemo(() => !term ? rows : rows.filter(({ d }) => matchesAll(`${d.peer.displayName} ${d.peer.login}`, term)), [rows, term]);
  const active = dialogs.find((d) => d.id === activeId);
  // диалог мог быть удалён собеседником — сбрасываем сохранённый выбор, когда БД уже загружена
  useEffect(() => {
    if (activeId && renamed[activeId]) setActiveId(renamed[activeId]); // диалог получил серверный id
    else if (db && activeId && dialogs.length && !active) setActiveId(null);
  }, [db, dialogs, activeId, renamed]);
  const me = session!.user.id;
  const edge = useRef<{ x: number; y: number } | null>(null);
  return (
    <div className={'main ' + (active ? 'open' : '')}>
      <aside className="side">
        <div className="side-head">
          <h3>Чаты</h3>
          <button className="icbtn" onClick={() => setNewGroup(true)} aria-label="Новая беседа" title="Новая беседа"><Plus /></button>
        </div>
        <input className="field search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя или логин собеседника" aria-label="Поиск по собеседникам" />
        <div className="list">
          {!db && Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="skrow" aria-hidden="true">
              <div className="sk av" />
              <div style={{ flex: 1 }}><div className="sk l1" /><div className="sk l2" style={{ width: `${45 + (i * 13) % 40}%` }} /></div>
            </div>
          ))}
          {shownRows.map(({ d, last }) => (
            <SwipeRow key={d.id} label={d.kind === 'group' ? (d.myRole === 'owner' ? 'Удалить' : 'Выйти') : 'Удалить'} onAction={() => setDelRow(d)}>
            <button className="row" aria-current={d.id === activeId} onClick={() => setActiveId(d.id)}>
              <Avatar name={d.peer.displayName} url={d.peer.avatarUrl} online={presence[d.peer.id] ?? false} size={46} />
              <div className="t">
                <div className="n">{d.peer.displayName}<small>{last ? fmtTime(last.createdAt) : ''}</small></div>
                <div className="m">
                  <span>{last ? (last.senderId === me ? 'Вы: ' : '') + previewOf(last) : 'Новый диалог'}</span>
                  {d.unread > 0 && <b className="badge">{d.unread}</b>}
                </div>
              </div>
            </button>
            </SwipeRow>
          ))}
          {db && !shownRows.length && !term && <div className="empty">Пока пусто. Откройте раздел «Люди» и выберите собеседника.</div>}
          {!shownRows.length && term && <div className="empty">Среди ваших собеседников такого нет.</div>}
          {term && <button className="ghost more" onClick={() => onFindPeople(term)}>Искать «{term}» среди всех людей</button>}
        </div>
      </aside>
      <section className="chat"
        onTouchStart={(e) => { const t = e.touches[0]; edge.current = t.clientX < 28 && active && matchMedia('(max-width:760px)').matches ? { x: t.clientX, y: t.clientY } : null; }}
        onTouchEnd={(e) => {
          const s0 = edge.current; edge.current = null;
          if (!s0) return;
          const t = e.changedTouches[0], dx = t.clientX - s0.x, dy = Math.abs(t.clientY - s0.y);
          if (dx > 80 && dx > dy * 2) setActiveId(null);   // свайп от левого края — назад к списку
        }}>
        {active ? <ChatView key={active.id} dialog={active} onClose={() => setActiveId(null)} />
          : <div className="blank"><div><h2>Выберите диалог</h2><p>Или найдите собеседника в разделе «Люди».</p></div></div>}
      </section>
      {delRow && (
        <ConfirmModal title={delRow.kind === 'group' ? (delRow.myRole === 'owner' ? 'Удалить беседу?' : 'Выйти из беседы?') : 'Удалить диалог?'}
          confirmLabel={delRow.kind === 'group' ? (delRow.myRole === 'owner' ? 'Удалить беседу' : 'Выйти') : 'Удалить диалог'}
          onCancel={() => setDelRow(null)}
          onConfirm={() => {
            const d = delRow; setDelRow(null);
            removeDialog(d.id).then(() => { if (activeId === d.id) setActiveId(null); toast(d.kind === 'group' ? 'Готово' : 'Диалог удалён у обоих участников'); }).catch((e) => toast(e.message));
          }}>
          {delRow.kind === 'group'
            ? (delRow.myRole === 'owner' ? `Беседа «${delRow.peer.displayName}» и вся переписка будут удалены у всех участников. Это нельзя отменить.` : `Вы выйдете из беседы «${delRow.peer.displayName}» и перестанете получать сообщения.`)
            : `Вся переписка с ${delRow.peer.displayName} будет удалена у обоих участников. Это нельзя отменить.`}
        </ConfirmModal>
      )}
      {newGroup && <NewGroupModal onClose={() => setNewGroup(false)} onCreated={(id) => { setNewGroup(false); setActiveId(id); }} />}
    </div>
  );
}

interface MenuState { x: number; y: number; m: MessageDoc; sel: string }

function ChatView({ dialog, onClose }: { dialog: DialogDoc; onClose: () => void }) {
  const { session } = useAuth();
  const { status, typing, typingUser, members, loadMembers, sendMedia, presence, lastSeen, pins, send, retry, remove, edit, setPinned, loadPins, reactions, loadReactions, react, removeDialog, loadOlder, notifyTyping, setActive } = useChat();
  const toast = useToast();
  const me = session!.user.id;
  const raw = useLiveQuery<MessageDoc>((d) => d.messages.find({ selector: { dialogId: dialog.id } }), [dialog.id]);
  const msgs = useMemo(() => raw.filter((m) => !m.isDeleted).sort(sortMessages), [raw]);
  const byId = useMemo(() => new Map(msgs.filter((m) => m.id).map((m) => [m.id, m])), [msgs]);
  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true), first = useRef(true), busy = useRef(false), more = useRef(true), jumping = useRef(false);
  const anchor = useRef<number | null>(null), saveT = useRef<number>();
  const press = useRef<number>();
  const [delMsg, setDelMsg] = useState<MessageDoc | null>(null);   // сообщение, ожидающее подтверждения удаления
  const [delDialog, setDelDialog] = useState(false);
  const [editing, setEditing] = useState<MessageDoc | null>(null);
  const [replying, setReplying] = useState<MessageDoc | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [fwd, setFwd] = useState<MessageDoc | null>(null);
  const [profile, setProfile] = useState(false);
  const [groupInfo, setGroupInfo] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [hasText, setHasText] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  const voice = useVoiceRecorder();
  const isGroup = dialog.kind === 'group';
  const nameOf = (uid: string) => uid === me ? 'Вы' : members[dialog.id]?.find((x) => x.user.id === uid)?.user.displayName ?? (isGroup ? 'Участник' : dialog.peer.displayName);
  const [pinIdx, setPinIdx] = useState(0);
  const [showDown, setShowDown] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [fq, setFq] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [hitsMore, setHitsMore] = useState(false);
  const [hitsBusy, setHitsBusy] = useState(false);
  const [jumpId, setJumpId] = useState<string | null>(null);
  const tempDialog = dialog.id.startsWith('L');
  const fterm = fq.trim();
  const isTyping = !!typing[dialog.id];
  const pinned = (pins[dialog.id] ?? []).map((id) => byId.get(id)).filter((m): m is MessageDoc => !!m);
  useEffect(() => { setActive(dialog.id); return () => setActive(null); }, [dialog.id]);
  useEffect(() => { if (isGroup) loadMembers(dialog.id).catch(() => {}); }, [dialog.id, status === 'online']);
  useEffect(() => { loadPins(dialog.id).catch((e) => console.warn('pins load failed', e)); }, [dialog.id, status === 'online']);
  useEffect(() => { loadReactions(dialog.id).catch((e) => console.warn('reactions load failed', e)); }, [dialog.id, status === 'online']);
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
  const flash = (id: string): boolean => {
    const el = document.getElementById('m-' + id);
    if (!el) return false;
    stick.current = false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1800);
    return true;
  };
  // переход к сообщению: если оно ещё не загружено на устройство, подгружаем историю страницами вверх, пока не найдётся
  useEffect(() => { if (jumpId && flash(jumpId)) setJumpId(null); }, [jumpId, msgs]);
  const byIdRef = useRef(byId); byIdRef.current = byId;
  const goTo = async (id: string, maxPages = 10) => {
    if (!id) return;
    setJumpId(id);
    if (byIdRef.current.has(id) || jumping.current) return;
    jumping.current = true; setHitsBusy(true);
    try {
      for (let i = 0; i < maxPages && more.current && !byIdRef.current.has(id); i++) {
        const n = await loadOlder(dialog.id);
        if (n < 50) more.current = false;
        await new Promise((r) => setTimeout(r, 80));   // дать живому запросу обновить список
      }
      if (!byIdRef.current.has(id)) { setJumpId(null); toast('Сообщение не найдено в загруженной истории'); }
    } catch { setJumpId(null); toast('Не удалось подгрузить историю'); }
    finally { jumping.current = false; setHitsBusy(false); }
  };
  const jumpTo = (id: string) => { void goTo(id); };
  // поиск по тексту внутри этого чата: на сервере по всей истории, без сети — по локальной копии
  const toHit = (m: { id: string; senderId: string; text: string; createdAt: number | string; clientMessageId?: string }): Hit => ({
    key: m.clientMessageId || m.id, id: m.id, senderId: m.senderId, text: m.text,
    createdAt: typeof m.createdAt === 'string' ? Date.parse(m.createdAt) : m.createdAt,
  });
  useEffect(() => {
    if (!findOpen || fterm.length < 2) { setHits(null); setHitsMore(false); return; }
    let stale = false;
    const t = setTimeout(async () => {
      let list: Hit[], more2 = false;
      try {
        if (tempDialog) throw new Error('local');
        const r = await api.searchMessages(fterm, { dialogId: dialog.id, limit: 30 });
        list = r.map(toHit); more2 = r.length === 30;
      } catch {
        list = msgs.filter((m) => matchesAll(m.text, fterm)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map(toHit);
      }
      if (!stale) { setHits(list); setHitsMore(more2); }
    }, 300);
    return () => { stale = true; clearTimeout(t); };
  }, [fq, findOpen]);
  const moreHits = async () => {
    const last = hits?.[hits.length - 1]; if (!last?.id) return;
    setHitsBusy(true);
    try {
      const r = await api.searchMessages(fterm, { dialogId: dialog.id, before: last.id, limit: 30 });
      setHits((h) => [...(h ?? []), ...r.map(toHit)]); setHitsMore(r.length === 30);
    } catch (e) { toast((e as Error).message); } finally { setHitsBusy(false); }
  };
  const openHit = (h: Hit) => {
    if (h.id) void goTo(h.id, 40);
    if (window.matchMedia('(max-width: 760px)').matches) setFindOpen(false);
  };
  const closeFind = () => { setFindOpen(false); setFq(''); };
  const onScroll = () => {
    const el = box.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    setShowDown(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
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
  const cancelEdit = () => { setEditing(null); setHasText(false); const el = ta.current!; el.value = ''; el.style.height = ''; };
  const startEdit = (m: MessageDoc) => { setReplying(null); setEditing(m); setHasText(true); const el = ta.current!; el.value = m.text; resize(); el.focus(); };
  const startReply = (m: MessageDoc) => { if (editing) cancelEdit(); setReplying(m); ta.current!.focus(); };
  const submit = () => {
    const t = ta.current!.value.trim(); if (!t) return;
    if (editing) {
      edit(editing, t.slice(0, 4000)).then(cancelEdit).catch((e: Error) => toast(e.message));
      return;
    }
    send(dialog.id, t.slice(0, 4000), replying?.id || undefined);
    setReplying(null);
    ta.current!.value = ''; ta.current!.style.height = ''; stick.current = true; setHasText(false);
  };
  const sendImage = (f?: File | null) => {
    if (fileIn.current) fileIn.current.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast('Это не картинка'); return; }
    if (f.size > 10 * 1024 * 1024) { toast('Файл больше 10 МБ'); return; }
    sendMedia(dialog.id, 'image', f, { text: ta.current!.value.trim().slice(0, 1000), replyToId: replying?.id || undefined });   // подпись — набранный текст
    ta.current!.value = ''; ta.current!.style.height = ''; setHasText(false); setReplying(null); stick.current = true;
  };
  const startVoice = async () => { try { await voice.start(); } catch { toast('Нет доступа к микрофону — разрешите его в настройках браузера'); } };
  const sendVoice = async () => {
    const r = await voice.finish();
    if (!r) { toast('Запись слишком короткая'); return; }
    sendMedia(dialog.id, 'voice', r.blob, { durationMs: r.durationMs, replyToId: replying?.id || undefined });
    setReplying(null); stick.current = true;
  };
  useEffect(() => { if (voice.seconds >= 300) void sendVoice(); }, [voice.seconds]);   // запись не длиннее 5 минут
  const [emo, setEmo] = useState<DOMRect | null>(null);
  const insertEmoji = (em: string) => {
    const el = ta.current;
    if (!el) return;
    const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a;
    el.setRangeText(em, a, b, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));   // обновит hasText и высоту поля через onChange
    el.focus();
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
  const togglePin = (m: MessageDoc, on: boolean) =>
    setPinned(m, on).catch((e: Error) => toast(e.message));
  // ---------- Контекстное меню: ПКМ, долгое нажатие, кнопка «⋯» ----------
  const menuItems = ({ m, sel }: MenuState): MenuItem[] => {
    const sent = !!m.id && m.status === 'sent';
    const isPinned = (pins[dialog.id] ?? []).includes(m.id);
    const items: MenuItem[] = [];
    if (sent) items.push({ label: 'Ответить', onClick: () => startReply(m) });
    if (m.text) items.push({ label: sel ? 'Копировать выделенное' : 'Копировать', onClick: () => { void copyText(sel || m.text).then(() => toast('Скопировано')); } });
    if (m.senderId === me && m.status !== 'failed' && (m.kind ?? 'text') === 'text') items.push({ label: 'Изменить', onClick: () => startEdit(m) });
    if (sent) {
      items.push({ label: isPinned ? 'Открепить' : 'Закрепить', onClick: () => togglePin(m, !isPinned) });
      items.push({ label: 'Переслать…', onClick: () => setFwd(m) });
    }
    items.push({ label: 'Удалить', danger: true, onClick: () => askDelete(m) });
    return items;
  };
  const openMenu = (e: RMouseEvent<HTMLElement>, m: MessageDoc) => {
    e.preventDefault();
    const s = window.getSelection();
    const sel = s && !s.isCollapsed && e.currentTarget.contains(s.anchorNode) ? s.toString().trim() : '';
    setMenu({ x: e.clientX, y: e.clientY, m, sel });
  };
  const touchStart = (e: RTouchEvent<HTMLElement>, m: MessageDoc) => {
    const t = e.touches[0];
    clearTimeout(press.current);
    swipe.current = { x: t.clientX, y: t.clientY, dx: 0, locked: false, buzzed: false };
    press.current = window.setTimeout(() => { try { navigator.vibrate?.(8); } catch { /* не поддерживается */ } setMenu({ x: t.clientX, y: t.clientY, m, sel: '' }); }, 500);
  };
  const touchEnd = () => clearTimeout(press.current);
  // Свайп влево по сообщению — ответить (как в Telegram)
  const swipe = useRef<{ x: number; y: number; dx: number; locked: boolean; buzzed: boolean } | null>(null);
  const SWIPE_AT = 56;
  const touchMove = (e: RTouchEvent<HTMLElement>) => {
    touchEnd();
    const s = swipe.current;
    if (!s) return;
    const t = e.touches[0], dx = s.x - t.clientX, dy = t.clientY - s.y;
    if (!s.locked) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe.current = null; return; }   // это прокрутка
      if (dx > 10 && dx > Math.abs(dy)) s.locked = true; else return;
    }
    s.dx = Math.min(72, Math.max(0, dx));
    const el = e.currentTarget;
    el.classList.add('swiping');
    el.style.transition = 'none';
    el.style.transform = `translateX(${-s.dx}px)`;
    el.style.setProperty('--sw', String(Math.min(1, s.dx / SWIPE_AT)));
    if (s.dx >= SWIPE_AT && !s.buzzed) { s.buzzed = true; try { navigator.vibrate?.(10); } catch { /* не поддерживается */ } }
  };
  const touchFinish = (e: RTouchEvent<HTMLElement>, m: MessageDoc, cancelled = false) => {
    touchEnd();
    const s = swipe.current; swipe.current = null;
    if (!s?.locked) return;
    const el = e.currentTarget;
    el.style.transition = 'transform .18s ease-out'; el.style.transform = '';
    window.setTimeout(() => { el.classList.remove('swiping'); el.style.transition = ''; el.style.removeProperty('--sw'); }, 200);
    if (!cancelled && s.dx >= SWIPE_AT && m.id && m.status === 'sent') startReply(m);
  };
  const toggleReact = (m: MessageDoc, emoji: string) =>
    react(m, reactions[m.id]?.[me] === emoji ? null : emoji).catch((er: Error) => toast(er.message));

  let day = '';
  const items = msgs.map((m, i) => {
    const d = fmtDay(m.createdAt), sep = d !== day; day = d;
    const prev = msgs[i - 1];
    const gp = !!prev && !sep && prev.senderId === m.senderId && m.createdAt - prev.createdAt < 5 * 60_000;   // продолжение группы подряд идущих сообщений
    if (m.kind === 'system') return (
      <div key={m.clientMessageId} style={{ display: 'contents' }}>
        {sep && <div className="day"><span>{d}</span></div>}
        <div className="sysmsg"><span>{m.text}</span></div>
      </div>
    );
    const out = m.senderId === me;
    const state = m.status === 'pending' ? ' · отправляется' : m.status === 'failed' ? ' · не отправлено'
      : !isGroup && m.id && dialog.peerRead >= m.id ? ' · прочитано' : ' · доставлено';
    const target = m.replyToId ? byId.get(m.replyToId) : undefined;
    return (
      <div key={m.clientMessageId} style={{ display: 'contents' }}>
        {sep && <div className="day"><span>{d}</span></div>}
        <div id={m.id ? 'm-' + m.id : undefined} className={`msg ${out ? 'out' : 'in'} ${m.status}${gp ? ' gp' : ''}${m.kind === 'image' && !m.text && !m.replyToId && !m.fwdFrom ? ' mo' : ''}`}
          onContextMenu={(e) => openMenu(e, m)} onTouchStart={(e) => touchStart(e, m)} onTouchEnd={(e) => touchFinish(e, m)} onTouchMove={touchMove} onTouchCancel={(e) => touchFinish(e, m, true)}
          onDoubleClick={(e) => {
            if (!m.id || m.status !== 'sent' || (e.target as HTMLElement).closest('button,a,audio')) return;
            window.getSelection()?.removeAllRanges();
            toggleReact(m, '👍');
          }}>
          {m.id && m.status === 'sent' && (
            <div className="qr" role="group" aria-label="Быстрая реакция">
              {REACTIONS.map((e) => (
                <button key={e} className={reactions[m.id]?.[me] === e ? 'on' : ''} aria-label={'Реакция ' + e} aria-pressed={reactions[m.id]?.[me] === e}
                  onClick={() => toggleReact(m, e)}>{e}</button>
              ))}
            </div>
          )}
          {isGroup && !out && !gp && <div className="sname" style={{ ['--h' as string]: hue(m.senderId) }}>{nameOf(m.senderId)}</div>}
          {m.fwdFrom && <div className="fwd">Переслано от <b>{m.fwdFrom}</b></div>}
          {m.replyToId && (
            <button className="quote" onClick={() => jumpTo(m.replyToId)}>
              <b>{target ? nameOf(target.senderId) : 'Ответ'}</b>
              <span>{target ? previewOf(target) : 'Исходное сообщение недоступно'}</span>
            </button>
          )}
          {m.kind === 'image' && m.media && <ImageBubble m={m} onOpen={setLightbox} />}
          {m.kind === 'voice' && m.media && <VoicePlayer m={m} />}
          {m.text && <span className="txt">{m.text}</span>}
          {m.id && Object.keys(reactions[m.id] ?? {}).length > 0 && (
            <div className="rx">
              {Object.entries(Object.values(reactions[m.id]).reduce<Record<string, number>>((a, e) => ({ ...a, [e]: (a[e] ?? 0) + 1 }), {})).map(([e, n]) => (
                <button key={e + n} className={reactions[m.id][me] === e ? 'mine' : ''} aria-pressed={reactions[m.id][me] === e}
                  onClick={() => toggleReact(m, e)}><span className="e">{e}</span>{n > 1 && <span className="n">{n}</span>}</button>
              ))}
            </div>
          )}
          <span className="meta">
            {fmtTime(m.createdAt)}
            {m.editedAt > 0 && ' · изменено'}
            {m.id && (pins[dialog.id] ?? []).includes(m.id) && ' · закреплено'}
            {out && state}
          </span>
          {out && m.status === 'failed' && <button className="retry" onClick={() => retry(m)}>Повторить</button>}
          <button className="x more" aria-label="Действия с сообщением" title="Действия"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, m, sel: '' }); }}><Dots /></button>
        </div>
      </div>
    );
  });
  const peerOnline = !isGroup && (presence[dialog.peer.id] ?? false);
  const typingName = isGroup ? nameOf(typingUser[dialog.id] ?? '') : '';
  const sub = status !== 'online' ? 'нет соединения'
    : isTyping ? (isGroup ? `${typingName} печатает…` : 'печатает…')
    : isGroup ? membersLabel(members[dialog.id]?.length ?? dialog.memberCount)
    : peerOnline ? 'в сети' : lastSeen[dialog.peer.id] ? fmtLastSeen(lastSeen[dialog.peer.id]) : 'не в сети';
  const subCls = status !== 'online' ? '' : isTyping ? 'typing' : peerOnline ? 'on' : '';
  const pinCur = pinned.length ? pinned[pinIdx % pinned.length] : null;
  return (
    <>
      <div className="chead">
        <button className="ghost back" onClick={onClose} aria-label="К списку диалогов">←</button>
        <button className="peer-btn" onClick={() => (isGroup ? setGroupInfo(true) : setProfile(true))} aria-label={`${isGroup ? 'Беседа' : 'Профиль'}: ${dialog.peer.displayName}`}>
          <Avatar name={dialog.peer.displayName} url={dialog.peer.avatarUrl} online={peerOnline} />
          <div className="t">
            <div className="n">{dialog.peer.displayName}</div>
            <div className={'s ' + subCls}>{sub}</div>
          </div>
        </button>
        <button className="icbtn" onClick={() => setFindOpen((v) => !v)} aria-pressed={findOpen} aria-label="Поиск по сообщениям" title="Поиск по сообщениям"><Search /></button>
        <button className="icbtn" onClick={() => setDelDialog(true)} aria-label={isGroup ? (dialog.myRole === 'owner' ? 'Удалить беседу' : 'Выйти из беседы') : 'Удалить диалог'} title={isGroup ? (dialog.myRole === 'owner' ? 'Удалить беседу' : 'Выйти из беседы') : 'Удалить диалог'}><Trash /></button>
      </div>
      {findOpen && (
        <div className="findbar">
          <div className="findrow">
            <input className="field search" autoFocus value={fq} onChange={(e) => setFq(e.target.value)} placeholder="Поиск по сообщениям в этом чате"
              aria-label="Поиск по сообщениям" onKeyDown={(e) => { if (e.key === 'Escape') closeFind(); }} />
            <button className="ghost" onClick={closeFind}>Закрыть</button>
          </div>
          {fterm.length >= 2 && (
            <div className="hits">
              {!hits && <div className="empty">Ищем…</div>}
              {hits?.length === 0 && <div className="empty">В этом чате ничего не нашли.</div>}
              {hits?.map((h) => (
                <button key={h.key} className="hit" onClick={() => openHit(h)}>
                  <small>{nameOf(h.senderId)} · {fmtDay(h.createdAt)}, {fmtTime(h.createdAt)}</small>
                  <span>{h.text}</span>
                </button>
              ))}
              {hitsMore && !hitsBusy && <button className="ghost more" onClick={moreHits}>Показать ещё</button>}
              {hitsBusy && <div className="empty">Подгружаем…</div>}
            </div>
          )}
        </div>
      )}
      {pinCur && (
        <div className="pinbar">
          <button className="pinbody" onClick={() => { jumpTo(pinCur.id); setPinIdx((i) => i + 1); }}>
            <b>Закреплено{pinned.length > 1 ? ` · ${(pinIdx % pinned.length) + 1} из ${pinned.length}` : ''}</b>
            <span>{previewOf(pinCur)}</span>
          </button>
          <button className="ghost" onClick={() => togglePin(pinCur, false)} aria-label="Открепить сообщение" title="Открепить">✕</button>
        </div>
      )}
      <div className="msgs" ref={box} onScroll={onScroll}>
        {items.length ? items : <div className="empty" style={{ margin: 'auto' }}>Напишите первое сообщение.</div>}
        {isTyping && <div className="typing" aria-label="печатает"><i /><i /><i /></div>}
        {showDown && <button className="down" aria-label="К последним сообщениям" onClick={() => box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' })}>↓{dialog.unread > 0 && <b className="badge dbadge">{dialog.unread}</b>}</button>}
      </div>
      {editing && (
        <div className="editbar">
          <span>Редактирование · <i>{editing.text.length > 60 ? editing.text.slice(0, 60) + '…' : editing.text}</i></span>
          <button className="ghost" onClick={cancelEdit}>Отмена</button>
        </div>
      )}
      {replying && (
        <div className="editbar">
          <span>Ответ · <b>{nameOf(replying.senderId)}</b>: <i>{previewOf(replying).length > 60 ? previewOf(replying).slice(0, 60) + '…' : previewOf(replying)}</i></span>
          <button className="ghost" onClick={() => setReplying(null)}>Отмена</button>
        </div>
      )}
      <div className="comp">
        {voice.recording && (
          <>
            <button className="icbtn" onClick={voice.cancel} aria-label="Отменить запись" title="Отменить">✕</button>
            <div className="rec" role="status"><i />Запись · {fmtDuration(voice.seconds)}</div>
            <button className="send" onClick={() => void sendVoice()} aria-label="Отправить голосовое" title="Отправить">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12L20 4l-5 16-3.5-6.5L4 12z" /></svg>
            </button>
          </>
        )}
        <div className={'compin' + (voice.recording ? ' hide' : '')}>
          {!editing && (
            <>
              <input ref={fileIn} type="file" accept="image/*" hidden onChange={(e) => sendImage(e.target.files?.[0])} />
              <button className="icbtn" onClick={() => fileIn.current?.click()} aria-label="Прикрепить фото" title="Прикрепить фото"><Clip /></button>
            </>
          )}
          <textarea ref={ta} rows={1} maxLength={4000} placeholder={editing ? 'Новый текст сообщения' : 'Сообщение'} aria-label="Сообщение"
            onChange={() => { resize(); setHasText(!!ta.current?.value.trim()); if (!editing) notifyTyping(dialog.id); }}
            onPaste={(e) => { const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); sendImage(f); } }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              else if (e.key === 'Escape') { if (editing) cancelEdit(); else if (replying) setReplying(null); }
              else if (e.key === 'ArrowUp' && !editing && !e.currentTarget.value) {
                const last = [...msgs].reverse().find((x) => x.senderId === me && x.status === 'sent' && (x.kind ?? 'text') === 'text' && x.text);
                if (last) { e.preventDefault(); startEdit(last); }
              }
            }} />
          <button className="icbtn emobtn" aria-label="Эмодзи" title="Эмодзи" onClick={(e) => setEmo(emo ? null : e.currentTarget.getBoundingClientRect())}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8M9 9.5v.01M15 9.5v.01" /></svg>
          </button>
          {hasText || editing || !canRecord()
            ? (
              <button className="send" onClick={submit} aria-label={editing ? 'Сохранить' : 'Отправить'} title={editing ? 'Сохранить' : 'Отправить'}>
                {editing
                  ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12L20 4l-5 16-3.5-6.5L4 12z" /></svg>}
              </button>
            )
            : <button className="send" onClick={() => void startVoice()} aria-label="Записать голосовое" title="Голосовое сообщение"><Mic /></button>}
        </div>
      </div>
      {emo && <EmojiPop anchor={emo} onPick={insertEmoji} onClose={() => setEmo(null)} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} picker={menu.m.id && menu.m.status === 'sent' ? { current: reactions[menu.m.id]?.[me], onPick: (e) => react(menu.m, e).catch((er: Error) => toast(er.message)) } : undefined} onClose={() => setMenu(null)} />}
      {fwd && <ForwardModal msg={fwd} onClose={() => setFwd(null)} onDone={() => setFwd(null)} />}
      {profile && <PeerProfile peer={dialog.peer} online={peerOnline} onClose={() => setProfile(false)} />}
      {groupInfo && <GroupInfo dialog={dialog} onClose={() => setGroupInfo(false)} onLeft={() => { setGroupInfo(false); onClose(); }} />}
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
      {delMsg && (
        <ConfirmModal title="Удалить сообщение?" checkLabel={`Также удалить для ${dialog.peer.displayName}`}
          onCancel={() => setDelMsg(null)} onConfirm={delMsgNow}>
          <blockquote className="modal-quote">{delMsg.text}</blockquote>
        </ConfirmModal>
      )}
      {delDialog && (
        <ConfirmModal title={isGroup ? (dialog.myRole === 'owner' ? 'Удалить беседу?' : 'Выйти из беседы?') : 'Удалить диалог?'}
          confirmLabel={isGroup ? (dialog.myRole === 'owner' ? 'Удалить беседу' : 'Выйти') : 'Удалить диалог'} onCancel={() => setDelDialog(false)} onConfirm={delDialogNow}>
          {isGroup
            ? (dialog.myRole === 'owner' ? `Беседа «${dialog.peer.displayName}» и вся переписка будут удалены у всех участников. Это нельзя отменить.` : `Вы выйдете из беседы «${dialog.peer.displayName}» и перестанете получать сообщения.`)
            : `Вся переписка с ${dialog.peer.displayName} будет удалена у обоих участников. Это нельзя отменить.`}
        </ConfirmModal>
      )}
    </>
  );
}
