import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { HubConnectionBuilder, HubConnectionState, type HubConnection } from '@microsoft/signalr';
import { API_URL, api, token, ui, store } from './api';
import { dropDb, openDb, type MsgDb } from './db';
import type { Dialog, LocalMessage, Message, User } from './types';

export type ConnStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface Chat {
  me: User;
  db: MsgDb | null;
  dialogs: Dialog[];
  activeId: string | null;
  online: Record<string, boolean>;   // userId → в сети
  typing: Record<string, boolean>;   // dialogId → собеседник печатает
  exhausted: Record<string, boolean>; // dialogId → старше сообщений нет
  status: ConnStatus;
  open(id: string | null): void;
  send(dialogId: string, text: string): Promise<void>;
  retry(m: LocalMessage): Promise<void>;
  removeMessage(m: LocalMessage): Promise<void>;
  removeDialog(id: string): Promise<void>;
  startDialog(userId: string): Promise<void>;
  loadOlder(dialogId: string): Promise<void>;
  notifyTyping(dialogId: string): void;
  updateProfile(displayName: string, avatarUrl: string | null): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<Chat>(null as unknown as Chat);
export const useChat = () => useContext(Ctx);

const DKEY = 'msgr.dialogs.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastAt = (d: Dialog) => d.lastMessage?.createdAt ?? d.createdAt;
const byLast = (a: Dialog, b: Dialog) => lastAt(b).localeCompare(lastAt(a));
const toMessage = (m: LocalMessage): Message => ({
  id: m.id, clientMessageId: m.clientMessageId, dialogId: m.dialogId,
  senderId: m.senderId, text: m.text, mediaUrl: m.mediaUrl, createdAt: m.createdAt,
});

interface Props { me: User; onUser(u: User): void; onLogout(): void; children: ReactNode }

export function ChatProvider({ me, onUser, onLogout, children }: Props) {
  const [db, setDb] = useState<MsgDb | null>(null);
  const [dialogs, setDialogs] = useState<Dialog[]>(() => {
    try { return JSON.parse(localStorage.getItem(DKEY + me.id) ?? '[]'); } catch { return []; }
  });
  const [activeId, setActiveId] = useState<string | null>(ui.load().dialogId);
  const [online, setOnline] = useState<Record<string, boolean>>({});
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [exhausted, setExhausted] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<ConnStatus>('connecting');

  // Функции ниже читают только refs и стабильные сеттеры — их замыкания не «протухают».
  const dbRef = useRef<MsgDb | null>(null);
  const hubRef = useRef<HubConnection | null>(null);
  const dialogsRef = useRef(dialogs);
  const activeRef = useRef(activeId);
  const inFlight = useRef(new Set<string>());
  const typingTimers = useRef<Record<string, number>>({});
  const lastTyping = useRef(0);
  dialogsRef.current = dialogs;
  activeRef.current = activeId;

  /* ---------- диалоги ---------- */
  async function loadDialogs() {
    const list = await api.dialogs();
    setDialogs(list);
    localStorage.setItem(DKEY + me.id, JSON.stringify(list));
    if (activeRef.current && !list.some((d) => d.id === activeRef.current)) open(null);
    return list;
  }

  function touchDialog(m: Message) {
    setDialogs((ds) => {
      if (!ds.some((d) => d.id === m.dialogId)) return ds;
      return ds.map((d) => (d.id === m.dialogId ? { ...d, lastMessage: m } : d)).sort(byLast);
    });
  }

  /* ---------- слияние с локальной БД (проверка по clientMessageId) ---------- */
  async function upsert(m: Message) {
    await dbRef.current!.messages.upsert({ ...m, status: 'sent' });
  }

  /** Свежие 50 сообщений открытого диалога; заодно подхватываем удаления, случившиеся офлайн. */
  async function refreshOpen(id: string) {
    const d = dbRef.current;
    if (!d) return;
    try {
      const page = await api.messages(id, { limit: 50 });
      for (const m of page) await upsert(m);
      const full = page.length === 50;
      if (!full) setExhausted((e) => ({ ...e, [id]: true }));
      const keep = new Set(page.map((m) => m.id));
      const from = full ? page[0].id : '';
      const local = await d.messages.find({ selector: { dialogId: id, status: 'sent' } }).exec();
      await Promise.all(local.filter((x) => x.id >= from && !keep.has(x.id)).map((x) => x.remove()));
    } catch { /* офлайн — остаёмся на локальных данных */ }
  }

  async function loadOlder(dialogId: string) {
    const d = dbRef.current;
    if (!d) return;
    const sent = await d.messages.find({ selector: { dialogId, status: 'sent' } }).exec();
    const oldest = sent.map((x) => x.id).filter(Boolean).sort()[0];
    try {
      const page = await api.messages(dialogId, oldest ? { before: oldest, limit: 50 } : { limit: 50 });
      for (const m of page) await upsert(m);
      if (page.length < 50) setExhausted((e) => ({ ...e, [dialogId]: true }));
    } catch { /* повторим при следующей прокрутке */ }
  }

  /* ---------- отправка ---------- */
  async function deliver(cid: string) {
    const d = dbRef.current, hub = hubRef.current;
    if (!d || !hub || hub.state !== HubConnectionState.Connected || inFlight.current.has(cid)) return;
    const doc = await d.messages.findOne(cid).exec();
    if (!doc || doc.status !== 'pending') return;
    inFlight.current.add(cid);
    try {
      const ulid = await hub.invoke<string>('SendMessage', cid, doc.dialogId, doc.text);
      await doc.incrementalPatch({ id: ulid, status: 'sent' });
    } catch (e) {
      // forbidden / invalid_* — повторять бессмысленно; обрыв связи — остаётся pending до переподключения
      if (/forbidden|invalid_/.test(String((e as Error).message))) await doc.incrementalPatch({ status: 'failed' });
    } finally {
      inFlight.current.delete(cid);
    }
  }

  async function send(dialogId: string, text: string) {
    const d = dbRef.current;
    const t = text.trim();
    if (!d || !t || t.length > 4000) return;
    const msg: LocalMessage = {
      clientMessageId: crypto.randomUUID(), id: '', dialogId, senderId: me.id,
      text: t, mediaUrl: null, createdAt: new Date().toISOString(), status: 'pending',
    };
    await d.messages.insert(msg);
    touchDialog(toMessage(msg));
    void deliver(msg.clientMessageId);
  }

  async function retry(m: LocalMessage) {
    const doc = await dbRef.current?.messages.findOne(m.clientMessageId).exec();
    await doc?.incrementalPatch({ status: 'pending' });
    void deliver(m.clientMessageId);
  }

  async function removeMessage(m: LocalMessage) {
    if (m.status === 'sent' && m.id) await api.deleteMessage(m.id);
    const doc = await dbRef.current?.messages.findOne(m.clientMessageId).exec();
    await doc?.remove();
    void loadDialogs().catch(() => {});
  }

  /* ---------- синхронизация: дельта по LastSyncULID + повтор pending ---------- */
  async function sync() {
    const d = dbRef.current;
    if (!d) return;
    try {
      for (const dlg of await loadDialogs()) {
        const sent = await d.messages.find({ selector: { dialogId: dlg.id, status: 'sent' } }).exec();
        let last = sent.map((x) => x.id).filter(Boolean).sort().pop();
        if (!last) {
          for (const m of await api.messages(dlg.id, { limit: 50 })) await upsert(m);
          continue;
        }
        let page: Message[];
        do {
          page = await api.messages(dlg.id, { after: last, limit: 100 });
          for (const m of page) await upsert(m);
          if (page.length) last = page[page.length - 1].id;
        } while (page.length === 100);
      }
      if (activeRef.current) await refreshOpen(activeRef.current);
    } catch { /* офлайн или 401 (обработает api) */ }
    const pend = await d.messages.find({ selector: { status: 'pending' } }).exec();
    pend.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const p of pend) await deliver(p.clientMessageId);
  }

  /* ---------- жизненный цикл соединения ---------- */
  useEffect(() => {
    let dead = false;
    (async () => {
      const d = await openDb(me.id);
      if (dead) return;
      dbRef.current = d;
      setDb(d);

      const hub = new HubConnectionBuilder()
        .withUrl(`${API_URL}/hubs/chat`, { accessTokenFactory: token })
        .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (c) => Math.min(1000 * 2 ** c.previousRetryCount, 15000) })
        .build();
      hubRef.current = hub;

      // обработчики — строго до start()
      hub.on('MessageReceived', async (m: Message) => {
        await upsert(m);
        if (dialogsRef.current.some((x) => x.id === m.dialogId)) touchDialog(m);
        else void loadDialogs().catch(() => {});
      });
      hub.on('MessageAcked', async (cid: string, ulid: string) => {
        const doc = await d.messages.findOne(cid).exec();
        await doc?.incrementalPatch({ id: ulid, status: 'sent' });
      });
      hub.on('MessageDeleted', async (_dialogId: string, messageId: string) => {
        const docs = await d.messages.find({ selector: { id: messageId } }).exec();
        await Promise.all(docs.map((x) => x.remove()));
        void loadDialogs().catch(() => {});
      });
      hub.on('UserTyping', (dialogId: string) => {
        setTyping((t) => ({ ...t, [dialogId]: true }));
        clearTimeout(typingTimers.current[dialogId]);
        typingTimers.current[dialogId] = window.setTimeout(() => setTyping((t) => ({ ...t, [dialogId]: false })), 3000);
      });
      hub.on('PresenceChanged', (userId: string, s: 'online' | 'offline') =>
        setOnline((o) => ({ ...o, [userId]: s === 'online' })));

      hub.onreconnecting(() => setStatus('reconnecting'));
      hub.onreconnected(() => { setStatus('online'); void sync(); });
      hub.onclose(() => { setStatus('offline'); if (!store.load()) onLogout(); });

      while (!dead) {
        try {
          await hub.start();
          setStatus('online');
          await sync();
          return;
        } catch {
          setStatus('offline');
          await sleep(3000);
        }
      }
    })();
    return () => { dead = true; void hubRef.current?.stop(); };
  }, [me.id]);

  /* ---------- действия ---------- */
  function open(id: string | null) {
    setActiveId(id);
    ui.save({ dialogId: id });
    if (id) void refreshOpen(id);
  }

  async function startDialog(userId: string) {
    const dlg = await api.createDialog(userId);
    setDialogs((ds) => (ds.some((x) => x.id === dlg.id) ? ds : [dlg, ...ds]));
    open(dlg.id);
  }

  async function removeDialog(id: string) {
    await api.deleteDialog(id);
    const docs = await dbRef.current?.messages.find({ selector: { dialogId: id } }).exec();
    await Promise.all((docs ?? []).map((x) => x.remove()));
    setDialogs((ds) => ds.filter((x) => x.id !== id));
    if (activeRef.current === id) open(null);
  }

  function notifyTyping(dialogId: string) {
    const hub = hubRef.current;
    const now = Date.now();
    if (now - lastTyping.current < 2500 || hub?.state !== HubConnectionState.Connected) return;
    lastTyping.current = now;
    hub.invoke('Typing', dialogId).catch(() => {});
  }

  async function updateProfile(displayName: string, avatarUrl: string | null) {
    onUser(await api.updateMe({ displayName, avatarUrl }));
  }

  async function logout() {
    await api.logout();
    void hubRef.current?.stop();
    setDb(null);
    dbRef.current = null;
    await dropDb(me.id);
    localStorage.removeItem(DKEY + me.id);
    onLogout();
  }

  const value: Chat = {
    me, db, dialogs, activeId, online, typing, exhausted, status,
    open, send, retry, removeMessage, removeDialog, startDialog,
    loadOlder, notifyTyping, updateProfile, logout,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
