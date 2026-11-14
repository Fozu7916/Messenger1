import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { HubConnectionBuilder, HubConnectionState, type HubConnection } from '@microsoft/signalr';
import type { Observable } from 'rxjs';
import * as api from './api';
import { useAuth } from './auth';
import { closeDb, openDb, type DB } from './db';
import { beep, getNotifyPrefs, showDesktop } from './notify';
import { useToast } from '../components/ui';
import type { DialogDoc, DialogDto, Member, MessageDoc, MessageDto, User } from '../types';

export type ConnStatus = 'connecting' | 'online' | 'offline';

interface Chat {
  db: DB | null;
  dbError: string;                      // не удалось открыть локальную БД
  error: string;                        // последняя ошибка синхронизации ('' — всё хорошо)
  status: ConnStatus;                   // состояние SignalR
  typing: Record<string, boolean>;      // dialogId → собеседник печатает
  typingUser: Record<string, string>;   // dialogId → userId печатающего (в беседах показываем имя)
  members: Record<string, Member[]>;    // dialogId → участники беседы (подгружаются при открытии)
  loadMembers(dialogId: string): Promise<void>;
  createGroup(title: string, memberIds: string[]): Promise<string>;
  sendMedia(dialogId: string, kind: 'image' | 'voice', file: Blob, opts?: { text?: string; durationMs?: number; replyToId?: string }): void;
  presence: Record<string, boolean>;    // userId → онлайн
  lastSeen: Record<string, number>;     // userId → время последнего выхода (мс)
  renamed: Record<string, string>;      // временный id диалога → серверный id
  setActive(id: string | null): void;
  pins: Record<string, string[]>;       // dialogId → серверные id закреплённых сообщений (сначала закреплённые позже)
  send(dialogId: string, text: string, replyToId?: string): void;
  retry(m: MessageDoc): void;
  remove(m: MessageDoc, scope: 'me' | 'all'): Promise<void>;
  edit(m: MessageDoc, text: string): Promise<void>;
  forward(list: MessageDoc[], toDialogId: string): Promise<void>;
  loadPins(dialogId: string): Promise<void>;
  setPinned(m: MessageDoc, pinned: boolean): Promise<void>;
  startDialog(user: User): Promise<string>;
  removeDialog(id: string): Promise<void>;
  loadOlder(dialogId: string): Promise<number>;
  notifyTyping(dialogId: string): void;
  resync(): Promise<void>;
  resetLocal(): Promise<void>;
}
const Ctx = createContext<Chat>(null as unknown as Chat);
export const useChat = () => useContext(Ctx);

// ULID не содержит букв I, L, O, U — поэтому префикс 'L' однозначно означает «временный локальный id».
const isTemp = (id: string) => id.startsWith('L');
const plain = <T,>(docs: any[]): T[] => docs.map((d) => d.toJSON() as T);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const newId = () => typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID() // доступен только на HTTPS и localhost
  : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14);
const toPeer = (u: User) => ({ id: u.id, login: u.login, displayName: u.displayName, avatarUrl: u.avatarUrl ?? '' });
const toLocal = (m: MessageDto): MessageDoc => ({
  clientMessageId: m.clientMessageId || m.id, id: m.id, dialogId: m.dialogId, senderId: m.senderId,
  text: m.text, createdAt: Date.parse(m.createdAt), status: 'sent', isDeleted: false,
  editedAt: m.editedAt ? Date.parse(m.editedAt) : 0,
  replyToId: m.replyToId ?? '', fwdFrom: m.forwardedFromName ?? '',
  kind: m.kind ?? 'text', media: m.mediaUrl ?? '', mw: m.mediaWidth ?? 0, mh: m.mediaHeight ?? 0, dur: m.mediaDurationMs ?? 0,
});
/** Текст для превью и уведомлений: у вложений без подписи — название вложения. */
export const previewOf = (m: { text: string; kind?: string }) => m.text || (m.kind === 'image' ? 'Фото' : m.kind === 'voice' ? 'Голосовое сообщение' : '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Живой запрос к RxDB: компонент перерисовывается при любом изменении данных. */
export function useLiveQuery<T>(make: (db: DB) => { $: Observable<any> } | null, deps: unknown[]): T[] {
  const { db } = useChat();
  const [rows, setRows] = useState<T[]>([]);
  useEffect(() => {
    if (!db) return;
    const q = make(db);
    if (!q) { setRows([]); return; }
    const sub = q.$.subscribe((docs: any[]) => setRows(plain<T>(docs)));
    return () => sub.unsubscribe();
  }, [db, ...deps]);
  return rows;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const me = session!.user;
  const toast = useToast();

  const [db, setDb] = useState<DB | null>(null);
  const [dbError, setDbError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [lastSeen, setLastSeen] = useState<Record<string, number>>({});
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [pins, setPins] = useState<Record<string, string[]>>({});
  const [typingUser, setTypingUser] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<Record<string, Member[]>>({});
  const membersRef = useRef(members); membersRef.current = members;
  const blobs = useRef(new Map<string, Blob>());   // ещё не отправленные вложения (живут, пока открыта вкладка)

  const dbRef = useRef<DB | null>(null);
  const hubRef = useRef<HubConnection | null>(null);
  const activeRef = useRef<string | null>(null);
  const inflight = useRef(new Set<string>());
  const creating = useRef(new Map<string, Promise<string | null>>());
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timers = useRef<Record<string, number>>({});
  const lastTyping = useRef(0);
  const readMark = useRef(new Map<string, string>()); // dialogId → ULID, до которого уже отправили MarkRead
  const baseTitle = useRef(document.title);

  const connected = () => hubRef.current?.state === HubConnectionState.Connected;
  const report = (e: unknown) => { console.error(e); setError(errText(e)); };
  const upsertMessages = (list: MessageDto[]) => dbRef.current!.messages.bulkUpsert(list.map(toLocal));
  const loadMembers = async (dialogId: string) => {
    if (isTemp(dialogId)) return;
    const list = await api.groupMembers(dialogId);
    setMembers((m) => ({ ...m, [dialogId]: list }));
  };
  const dropPin = (messageId: string) =>
    setPins((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.filter((x) => x !== messageId)])));
  // Закреплённые приходят с сервера (общие для обоих участников); сами сообщения кладём в локальную БД, чтобы показать текст
  const loadPins = async (dialogId: string) => {
    if (isTemp(dialogId) || !dbRef.current) return;
    const list = await api.pins(dialogId);
    await upsertMessages(list);
    setPins((p) => ({ ...p, [dialogId]: list.map((x) => x.id) }));
  };

  // ---------- Диалог, созданный офлайн, превращается в серверный ----------
  const materialize = (tempId: string): Promise<string | null> => {
    const running = creating.current.get(tempId);
    if (running) return running;
    const p = (async () => {
      const d = dbRef.current!;
      const tmp = await d.dialogs.findOne(tempId).exec();
      if (!tmp) return null;
      const t = tmp.toJSON() as DialogDoc;
      const dto = await api.createDialog(t.peer.id); // бросит ошибку, пока нет сети
      await d.dialogs.upsert({ id: dto.id, createdAt: Date.parse(dto.createdAt), peer: toPeer(dto.peer), unread: t.unread, peerRead: '', pending: false, kind: 'direct', memberCount: 2, myRole: 'member' });
      for (const m of await d.messages.find({ selector: { dialogId: tempId } }).exec()) await m.incrementalPatch({ dialogId: dto.id });
      await tmp.remove();
      setRenamed((r) => ({ ...r, [tempId]: dto.id }));
      return dto.id;
    })().finally(() => creating.current.delete(tempId));
    creating.current.set(tempId, p);
    return p;
  };

  // ---------- Синхронизация (REST) ----------
  const dropDialogLocal = async (id: string) => {
    const d = dbRef.current!;
    await d.messages.find({ selector: { dialogId: id } }).remove();
    await d.dialogs.findOne(id).remove();
  };

  const syncMessages = async (did: string) => {
    const d = dbRef.current!;
    const local = plain<MessageDoc>(await d.messages.find({ selector: { dialogId: did, status: 'sent' } }).exec()).filter((m) => m.id);
    let last = local.map((m) => m.id).sort().pop();
    if (!last) { await upsertMessages(await api.messages(did, { limit: 50 })); return; }
    for (;;) { // дельта по LastSyncULID
      const page = await api.messages(did, { after: last, limit: 100 });
      await upsertMessages(page);
      if (page.length < 100) break;
      last = page[page.length - 1].id;
    }
    // правки и удаления в дельту не попадают — обновляем «хвост» истории и сверяем с ним локальные сообщения
    const tail = await api.messages(did, { limit: 100 });
    await upsertMessages(tail);
    const from = tail[0]?.id ?? '';
    const alive = new Set(tail.map((m) => m.id));
    for (const m of local) {
      if (!m.isDeleted && m.id >= from && !alive.has(m.id)) {
        const doc = await d.messages.findOne(m.clientMessageId).exec();
        await doc?.incrementalPatch({ isDeleted: true });
      }
    }
  };

  const syncDialogs = async () => {
    const d = dbRef.current!;
    const list: DialogDto[] = await api.dialogs();
    const local = plain<DialogDoc>(await d.dialogs.find().exec());
    const visible = document.visibilityState === 'visible';
    const ids = new Set(list.map((x) => x.id));
    for (const x of local) if (!x.pending && !ids.has(x.id)) await dropDialogLocal(x.id); // удалён собеседником
    await d.dialogs.bulkUpsert(list.map((x) => ({
      id: x.id, createdAt: Date.parse(x.createdAt), peer: toPeer(x.peer),
      unread: activeRef.current === x.id && visible ? 0 : x.unreadCount,
      peerRead: x.peerLastReadId ?? '', pending: false,
      kind: x.kind ?? 'direct', memberCount: x.memberCount ?? 2, myRole: x.myRole ?? 'member',
    })));
    for (const x of local) if (x.pending) void materialize(x.id).catch(() => {}); // досоздаём офлайн-диалоги
    const res = await Promise.allSettled(list.map((x) => syncMessages(x.id)));
    res.forEach((r) => r.status === 'rejected' && console.error('syncMessages failed', r.reason));
  };

  // ---------- Отправка (Offline-First) ----------
  const push = async (cid: string) => {
    if (!connected() || inflight.current.has(cid)) return;
    inflight.current.add(cid);
    const d = dbRef.current!;
    let retryPlain = false;
    try {
      const doc = await d.messages.findOne(cid).exec();
      if (!doc) return;
      let m = doc.toJSON() as MessageDoc;
      if (m.status === 'sent') return;
      if (isTemp(m.dialogId)) {
        const real = await materialize(m.dialogId);
        if (!real) return;
        m = { ...m, dialogId: real };
      }
      if (m.kind === 'image' || m.kind === 'voice') {   // вложения уходят по REST (multipart), а не через хаб
        const blob = blobs.current.get(cid);
        if (!blob) { await (await d.messages.findOne(cid).exec())?.incrementalPatch({ status: 'failed' }); return; }   // страницу перезагрузили до отправки
        const sent = toLocal(await api.sendMedia(m.dialogId, {
          clientMessageId: cid, kind: m.kind, file: blob, text: m.text, durationMs: m.dur, replyToId: m.replyToId || undefined,
        }));
        await (await d.messages.findOne(cid).exec())?.incrementalPatch({ id: sent.id, status: 'sent', media: sent.media, mw: sent.mw, mh: sent.mh, dur: sent.dur });
        blobs.current.delete(cid);
        return;
      }
      const serverUlid: string = m.replyToId
        ? await hubRef.current!.invoke('SendReply', m.clientMessageId, m.dialogId, m.text, m.replyToId)
        : await hubRef.current!.invoke('SendMessage', m.clientMessageId, m.dialogId, m.text);
      await (await d.messages.findOne(cid).exec())?.incrementalPatch({ id: serverUlid, status: 'sent' });
    } catch (e) {
      // ошибки валидации/доступа — повтор бессмысленен; сетевые — оставляем pending до появления сети
      if (/invalid_reply_to/.test(String(e))) { // исходное сообщение удалено — отправляем как обычное, а не теряем текст
        await (await d.messages.findOne(cid).exec())?.incrementalPatch({ replyToId: '' });
        retryPlain = true;
      }
      const fatal = !retryPlain && /forbidden|invalid_text|invalid_client_message_id/.test(String(e))
        || (e instanceof api.ApiError && (e.status === 400 || e.status === 404));
      if (fatal) await (await d.messages.findOne(cid).exec())?.incrementalPatch({ status: 'failed' });
      else if (!retryPlain) console.warn('push postponed', e);
    } finally { inflight.current.delete(cid); }
    if (retryPlain) await push(cid);
  };

  const flushPending = async () => {
    const pend = plain<MessageDoc>(await dbRef.current!.messages.find({ selector: { status: 'pending' } }).exec())
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const m of pend) await push(m.clientMessageId); // идемпотентность на сервере защищает от дублей
  };

  const runSync = async () => {
    try { await syncDialogs(); setError(''); } catch (e) { report(e); }
    try { await flushPending(); } catch (e) { report(e); }
    void refreshPresence();
    const a = activeRef.current;
    if (a) void loadPins(a).catch((e) => console.warn('pins refresh failed', e));
    if (a && document.visibilityState === 'visible') void markRead(a);
  };
  const sync = () => { chain.current = chain.current.then(runSync); return chain.current as Promise<void>; };

  // ---------- Онлайн, «прочитано», уведомления ----------
  const refreshPresence = async () => {
    if (!connected()) return;
    try {
      const ids: string[] = await hubRef.current!.invoke('GetOnlineContacts');
      setPresence(Object.fromEntries(ids.map((id) => [id, true])));
      const seen: Record<string, string> = await hubRef.current!.invoke('GetLastSeen');
      setLastSeen((p) => ({ ...p, ...Object.fromEntries(Object.entries(seen).map(([id, t]) => [id, Date.parse(t)])) }));
    } catch (e) { console.warn('presence refresh failed', e); }
  };

  const clearUnread = async (dialogId: string) => {
    const doc = await dbRef.current?.dialogs.findOne(dialogId).exec();
    if (doc && (doc.toJSON() as DialogDoc).unread) await doc.incrementalPatch({ unread: 0 });
  };

  /** Сообщаем серверу, что диалог прочитан до последнего входящего сообщения. */
  const markRead = async (dialogId: string) => {
    const d = dbRef.current;
    if (!d || isTemp(dialogId) || !connected()) return;
    const top = plain<MessageDoc>(await d.messages.find({ selector: { dialogId, status: 'sent' } }).exec())
      .filter((m) => m.id && m.senderId !== me.id && !m.isDeleted)
      .map((m) => m.id).sort().pop();
    if (!top || readMark.current.get(dialogId) === top) return;
    readMark.current.set(dialogId, top);
    try { await hubRef.current!.invoke('MarkRead', dialogId, top); }
    catch (e) { readMark.current.delete(dialogId); console.warn('markRead failed', e); }
  };

  const notifyIncoming = (peerName: string, text: string, dialogId: string) => {
    const prefs = getNotifyPrefs();
    const snippet = text.length > 80 ? text.slice(0, 80) + '…' : text;
    if (document.visibilityState === 'visible') toast(`${peerName}: ${snippet}`);
    else if (prefs.desktop) showDesktop(peerName, snippet, dialogId);
    if (prefs.sound) beep();
  };

  // ---------- События хаба ----------
  const onReceived = async (m: MessageDto) => {
    const d = dbRef.current!;
    const existing = await d.messages.findOne(m.clientMessageId).exec();
    if (m.senderId === me.id && existing) { // эхо собственного сообщения
      const e = existing.toJSON() as MessageDoc;
      if (e.status !== 'sent' || e.id !== m.id) await existing.incrementalPatch({ id: m.id, status: 'sent' });
      return;
    }
    await d.messages.upsert(toLocal(m));
    if (m.senderId === me.id) return;
    setTyping((t) => { const n = { ...t }; delete n[m.dialogId]; return n; });
    const dlg = await d.dialogs.findOne(m.dialogId).exec();
    if (!dlg) { await sync(); return; }
    if (m.kind === 'system') { void loadMembers(m.dialogId).catch(() => {}); return; }   // служебные: без счётчика и уведомления
    const watching = activeRef.current === m.dialogId && document.visibilityState === 'visible';
    if (watching) { void markRead(m.dialogId); return; }
    const info = dlg.toJSON() as DialogDoc;
    await dlg.incrementalModify((x) => ({ ...x, unread: x.unread + 1 }));
    const who = info.kind === 'group' ? membersRef.current[m.dialogId]?.find((x) => x.user.id === m.senderId)?.user.displayName : undefined;
    notifyIncoming(info.peer.displayName, (who ? who + ': ' : '') + previewOf(m), m.dialogId);
  };

  const onTyping = (did: string, uid: string) => {
    if (uid === me.id) return;
    setTyping((t) => ({ ...t, [did]: true }));
    setTypingUser((t) => ({ ...t, [did]: uid }));
    clearTimeout(timers.current[did]);
    timers.current[did] = window.setTimeout(() => setTyping((t) => { const n = { ...t }; delete n[did]; return n; }), 3500);
  };

  // ---------- Жизненный цикл ----------
  useEffect(() => {
    let dead = false;
    let hub: HubConnection | undefined;
    const onNet = () => { if (dbRef.current) void sync(); };
    window.addEventListener('online', onNet);
    const onVisible = () => {
      const id = activeRef.current;
      if (document.visibilityState === 'visible' && id && dbRef.current) { void clearUnread(id); void markRead(id); }
    };
    document.addEventListener('visibilitychange', onVisible);

    (async () => {
      let d: DB;
      try { d = await openDb(me.id); } catch (e) { console.error(e); if (!dead) setDbError(errText(e)); return; }
      if (dead) return;
      dbRef.current = d; setDb(d);
      void sync(); // REST не зависит от SignalR: интерфейс наполняется, даже если хаб недоступен

      hub = new HubConnectionBuilder()
        .withUrl(`${api.BASE}/hubs/chat`, { accessTokenFactory: () => api.getToken() ?? '' })
        .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (c) => Math.min(1000 * 2 ** c.previousRetryCount, 15000) })
        .build();
      hubRef.current = hub;

      hub.on('MessageReceived', (m: MessageDto) => void onReceived(m).catch(report));
      hub.on('MessageAcked', async (cid: string, ulid: string) => {
        await (await d.messages.findOne(cid).exec())?.incrementalPatch({ id: ulid, status: 'sent' });
      });
      hub.on('MessageDeleted', async (did: string, messageId: string) => {
        const doc = await d.messages.findOne({ selector: { id: messageId } }).exec();
        if (!doc) return;
        dropPin(messageId);
        const incoming = (doc.toJSON() as MessageDoc).senderId !== me.id;
        await doc.incrementalPatch({ isDeleted: true });
        // удалили непрочитанное входящее — пересчитываем счётчик непрочитанных с сервера
        if (incoming && ((await d.dialogs.findOne(did).exec())?.toJSON() as DialogDoc | undefined)?.unread) void syncDialogs().catch(report);
      });
      hub.on('MessageEdited', async (m: MessageDto) => {
        await (await d.messages.findOne({ selector: { id: m.id } }).exec())
          ?.incrementalPatch({ text: m.text, editedAt: m.editedAt ? Date.parse(m.editedAt) : Date.now() });
      });
      hub.on('MessagePinned', async (did: string, m: MessageDto) => {
        await upsertMessages([m]);
        setPins((p) => ({ ...p, [did]: [m.id, ...(p[did] ?? []).filter((x) => x !== m.id)] }));
      });
      hub.on('MessageUnpinned', (_did: string, messageId: string) => dropPin(messageId));
      hub.on('MessagesRead', async (did: string, uid: string, upTo: string) => {
        const doc = await d.dialogs.findOne(did).exec();
        if (!doc) return;
        const info = doc.toJSON() as DialogDoc;
        if (uid === me.id) { if (info.unread) await doc.incrementalPatch({ unread: 0 }); } // прочитано на другом устройстве
        else if (info.peerRead < upTo) await doc.incrementalPatch({ peerRead: upTo });
      });
      hub.on('UserTyping', onTyping);
      hub.on('DialogsChanged', () => { void sync().then(() => { const a = activeRef.current; if (a) return loadMembers(a); }).catch(report); });   // беседу создали/изменили/удалили
      hub.on('PresenceChanged', (uid: string, st: string, at?: string | null) => {
        setPresence((p) => ({ ...p, [uid]: st === 'online' }));
        if (st !== 'online' && at) setLastSeen((p) => ({ ...p, [uid]: Date.parse(at) }));
      });
      hub.onreconnecting(() => { setStatus('connecting'); setPresence({}); });
      hub.onreconnected(() => { setStatus('online'); void sync(); });

      const connect = async () => {
        while (!dead && hub!.state === HubConnectionState.Disconnected) {
          try { setStatus('connecting'); await hub!.start(); setStatus('online'); void sync(); void refreshPresence(); return; }
          catch (e) { console.warn('hub start failed', e); setStatus('offline'); await sleep(3000); }
        }
      };
      hub.onclose(() => { setStatus('offline'); setPresence({}); void connect(); });
      await connect();
    })();

    return () => {
      dead = true; window.removeEventListener('online', onNet); document.removeEventListener('visibilitychange', onVisible);
      hub?.stop(); dbRef.current = null; hubRef.current = null; setDb(null); void closeDb();
    };
  }, [me.id]);

  // Счётчик непрочитанных в заголовке вкладки
  useEffect(() => {
    if (!db) return;
    const base = baseTitle.current;
    const sub = db.dialogs.find().$.subscribe((docs) => {
      const n = docs.reduce((s, x) => s + (x.toJSON() as DialogDoc).unread, 0);
      document.title = n ? `(${n}) ${base}` : base;
    });
    return () => { sub.unsubscribe(); document.title = base; };
  }, [db]);

  // ---------- Действия интерфейса ----------
  const value: Chat = {
    db, dbError, error, status, typing, typingUser, members, loadMembers, presence, lastSeen, renamed, pins,
    createGroup: async (title, memberIds) => { const dto = await api.createGroup(title, memberIds); await sync(); return dto.id; },
    sendMedia: (dialogId, kind, file, opts) => {
      const cid = newId();
      blobs.current.set(cid, file);
      const m: MessageDoc = {
        clientMessageId: cid, id: '', dialogId, senderId: me.id, text: opts?.text ?? '', createdAt: Date.now(), status: 'pending',
        isDeleted: false, editedAt: 0, replyToId: opts?.replyToId ?? '', fwdFrom: '',
        kind, media: URL.createObjectURL(file), mw: 0, mh: 0, dur: Math.round(opts?.durationMs ?? 0),
      };
      dbRef.current!.messages.insert(m).then(() => push(cid)).catch(report);
    },
    setActive: (id) => {
      activeRef.current = id;
      if (id) { void clearUnread(id); void markRead(id); }
    },
    send: (dialogId, text, replyToId) => {
      const m: MessageDoc = {
        clientMessageId: newId(), id: '', dialogId, senderId: me.id, text,
        createdAt: Date.now(), status: 'pending', isDeleted: false, editedAt: 0,
        replyToId: replyToId ?? '', fwdFrom: '', kind: 'text', media: '', mw: 0, mh: 0, dur: 0,
      };
      // Optimistic UI: сообщение сразу попадает в локальную БД и на экран, сеть — потом
      dbRef.current!.messages.insert(m).then(() => push(m.clientMessageId)).catch(report);
    },
    retry: (m) => {
      void dbRef.current!.messages.findOne(m.clientMessageId).exec()
        .then((doc) => doc?.incrementalPatch({ status: 'pending' })).then(() => push(m.clientMessageId)).catch(report);
    },
    remove: async (m, scope) => {
      const doc = await dbRef.current!.messages.findOne(m.clientMessageId).exec();
      if (!doc) return;
      if (!m.id) { await doc.remove(); return; } // ещё не ушло на сервер
      await doc.incrementalPatch({ isDeleted: true });
      try { await api.deleteMessage(m.id, scope); }
      catch (e) { await doc.getLatest().incrementalPatch({ isDeleted: false }); throw e; }
    },
    edit: async (m, text) => {
      const t = text.trim();
      if (!t || t === m.text) return;
      const doc = await dbRef.current!.messages.findOne(m.clientMessageId).exec();
      if (!doc) return;
      if (!m.id) { await doc.incrementalPatch({ text: t }); return; } // ещё не ушло на сервер — правим локально
      const dto = await api.editMessage(m.id, t);
      await doc.getLatest().incrementalPatch({ text: dto.text, editedAt: dto.editedAt ? Date.parse(dto.editedAt) : Date.now() });
    },
    // Пересылка требует сети: копии создаёт сервер (он же проставляет исходного автора)
    forward: async (list, toDialogId) => {
      const sent = list.filter((m) => m.id && !isTemp(m.dialogId));
      if (!sent.length) throw new Error('Сообщение ещё не отправлено');
      let to = toDialogId;
      if (isTemp(to)) {
        const real = await materialize(to);
        if (!real) throw new Error('Не удалось создать диалог');
        to = real;
      }
      const batch = newId().replace(/-/g, '').slice(0, 32);
      await upsertMessages(await api.forward(sent[0].dialogId, { toDialogId: to, messageIds: sent.map((m) => m.id), clientBatchId: batch }));
    },
    loadPins,
    setPinned: async (m, pinned) => {
      if (!m.id) return;
      if (pinned) await api.pin(m.dialogId, m.id); else await api.unpin(m.dialogId, m.id);
      setPins((p) => {
        const cur = (p[m.dialogId] ?? []).filter((x) => x !== m.id);
        return { ...p, [m.dialogId]: pinned ? [m.id, ...cur] : cur };
      });
    },
    startDialog: async (user) => {
      const d = dbRef.current!;
      const have = plain<DialogDoc>(await d.dialogs.find().exec()).find((x) => x.peer.id === user.id);
      if (have) return have.id;
      // Диалог появляется в локальной БД мгновенно, на сервере создаётся, как только появится сеть
      const tempId = 'L' + user.id;
      await d.dialogs.upsert({ id: tempId, createdAt: Date.now(), peer: toPeer(user), unread: 0, peerRead: '', pending: true, kind: 'direct', memberCount: 2, myRole: 'member' });
      void materialize(tempId).catch((e) => console.warn('dialog will be created later', e));
      return tempId;
    },
    // Беседу владелец удаляет у всех, остальные из неё выходят; личный диалог удаляется у обоих
    removeDialog: async (id) => {
      if (!isTemp(id)) {
        const info = (await dbRef.current!.dialogs.findOne(id).exec())?.toJSON() as DialogDoc | undefined;
        if (info?.kind === 'group' && info.myRole !== 'owner') await api.removeMember(id, 'me'); else await api.deleteDialog(id);
      }
      await dropDialogLocal(id);
    },
    loadOlder: async (did) => {
      if (isTemp(did)) return 0;
      const ids = plain<MessageDoc>(await dbRef.current!.messages.find({ selector: { dialogId: did, status: 'sent' } }).exec())
        .map((m) => m.id).filter(Boolean).sort();
      if (!ids.length) return 0;
      const page = await api.messages(did, { before: ids[0], limit: 50 });
      await upsertMessages(page);
      return page.length;
    },
    notifyTyping: (did) => {
      const now = Date.now();
      if (!connected() || isTemp(did) || now - lastTyping.current < 2000) return;
      lastTyping.current = now;
      void hubRef.current!.send('Typing', did).catch(() => {});
    },
    resync: sync,
    resetLocal: async () => {
      const d = dbRef.current!;
      await d.messages.find().remove(); await d.dialogs.find().remove();
      await sync();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
