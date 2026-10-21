import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { HubConnectionBuilder, HubConnectionState, type HubConnection } from '@microsoft/signalr';
import type { Observable } from 'rxjs';
import * as api from './api';
import { useAuth } from './auth';
import { closeDb, openDb, type DB } from './db';
import type { DialogDoc, DialogDto, MessageDoc, MessageDto, User } from '../types';

export type ConnStatus = 'connecting' | 'online' | 'offline';

interface Chat {
  db: DB | null;
  dbError: string;                      // не удалось открыть локальную БД
  error: string;                        // последняя ошибка синхронизации ('' — всё хорошо)
  status: ConnStatus;                   // состояние SignalR
  typing: Record<string, boolean>;      // dialogId → собеседник печатает
  presence: Record<string, boolean>;    // userId → онлайн
  renamed: Record<string, string>;      // временный id диалога → серверный id
  setActive(id: string | null): void;
  send(dialogId: string, text: string): void;
  retry(m: MessageDoc): void;
  remove(m: MessageDoc): Promise<void>;
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
});
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
  const token = session!.token;

  const [db, setDb] = useState<DB | null>(null);
  const [dbError, setDbError] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [renamed, setRenamed] = useState<Record<string, string>>({});

  const dbRef = useRef<DB | null>(null);
  const hubRef = useRef<HubConnection | null>(null);
  const activeRef = useRef<string | null>(null);
  const inflight = useRef(new Set<string>());
  const creating = useRef(new Map<string, Promise<string | null>>());
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const timers = useRef<Record<string, number>>({});
  const lastTyping = useRef(0);

  const connected = () => hubRef.current?.state === HubConnectionState.Connected;
  const report = (e: unknown) => { console.error(e); setError(errText(e)); };
  const upsertMessages = (list: MessageDto[]) => dbRef.current!.messages.bulkUpsert(list.map(toLocal));

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
      await d.dialogs.upsert({ id: dto.id, createdAt: Date.parse(dto.createdAt), peer: toPeer(dto.peer), unread: t.unread, pending: false });
      for (const m of await d.messages.find({ selector: { dialogId: tempId } }).exec()) await m.patch({ dialogId: dto.id });
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
    // удаления в дельту не попадают — сверяем локальные сообщения с «хвостом» истории
    const tail = await api.messages(did, { limit: 100 });
    const from = tail[0]?.id ?? '';
    const alive = new Set(tail.map((m) => m.id));
    for (const m of local) {
      if (!m.isDeleted && m.id >= from && !alive.has(m.id)) {
        const doc = await d.messages.findOne(m.clientMessageId).exec();
        await doc?.patch({ isDeleted: true });
      }
    }
  };

  const syncDialogs = async () => {
    const d = dbRef.current!;
    const list: DialogDto[] = await api.dialogs();
    const local = plain<DialogDoc>(await d.dialogs.find().exec());
    const unread = new Map(local.map((x) => [x.id, x.unread]));
    const ids = new Set(list.map((x) => x.id));
    for (const x of local) if (!x.pending && !ids.has(x.id)) await dropDialogLocal(x.id); // удалён собеседником
    await d.dialogs.bulkUpsert(list.map((x) => ({
      id: x.id, createdAt: Date.parse(x.createdAt), peer: toPeer(x.peer), unread: unread.get(x.id) ?? 0, pending: false,
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
      const serverUlid: string = await hubRef.current!.invoke('SendMessage', m.clientMessageId, m.dialogId, m.text);
      await (await d.messages.findOne(cid).exec())?.patch({ id: serverUlid, status: 'sent' });
    } catch (e) {
      // ошибки валидации/доступа — повтор бессмысленен; сетевые — оставляем pending до появления сети
      const fatal = /forbidden|invalid_text|invalid_client_message_id/.test(String(e))
        || (e instanceof api.ApiError && (e.status === 400 || e.status === 404));
      if (fatal) await (await d.messages.findOne(cid).exec())?.patch({ status: 'failed' });
      else console.warn('push postponed', e);
    } finally { inflight.current.delete(cid); }
  };

  const flushPending = async () => {
    const pend = plain<MessageDoc>(await dbRef.current!.messages.find({ selector: { status: 'pending' } }).exec())
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const m of pend) await push(m.clientMessageId); // идемпотентность на сервере защищает от дублей
  };

  const runSync = async () => {
    try { await syncDialogs(); setError(''); } catch (e) { report(e); }
    try { await flushPending(); } catch (e) { report(e); }
  };
  const sync = () => { chain.current = chain.current.then(runSync); return chain.current as Promise<void>; };

  // ---------- События хаба ----------
  const onReceived = async (m: MessageDto) => {
    const d = dbRef.current!;
    const existing = await d.messages.findOne(m.clientMessageId).exec();
    if (m.senderId === me.id && existing) { // эхо собственного сообщения
      const e = existing.toJSON() as MessageDoc;
      if (e.status !== 'sent' || e.id !== m.id) await existing.patch({ id: m.id, status: 'sent' });
      return;
    }
    await d.messages.upsert(toLocal(m));
    if (m.senderId === me.id) return;
    setTyping((t) => { const n = { ...t }; delete n[m.dialogId]; return n; });
    const dlg = await d.dialogs.findOne(m.dialogId).exec();
    if (!dlg) { await sync(); return; }
    if (activeRef.current !== m.dialogId) await dlg.patch({ unread: (dlg.toJSON() as DialogDoc).unread + 1 });
  };

  const onTyping = (did: string, uid: string) => {
    if (uid === me.id) return;
    setTyping((t) => ({ ...t, [did]: true }));
    clearTimeout(timers.current[did]);
    timers.current[did] = window.setTimeout(() => setTyping((t) => { const n = { ...t }; delete n[did]; return n; }), 3500);
  };

  // ---------- Жизненный цикл ----------
  useEffect(() => {
    let dead = false;
    let hub: HubConnection | undefined;
    const onNet = () => { if (dbRef.current) void sync(); };
    window.addEventListener('online', onNet);

    (async () => {
      let d: DB;
      try { d = await openDb(me.id); } catch (e) { console.error(e); if (!dead) setDbError(errText(e)); return; }
      if (dead) return;
      dbRef.current = d; setDb(d);
      void sync(); // REST не зависит от SignalR: интерфейс наполняется, даже если хаб недоступен

      hub = new HubConnectionBuilder()
        .withUrl(`${api.BASE}/hubs/chat`, { accessTokenFactory: () => token })
        .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (c) => Math.min(1000 * 2 ** c.previousRetryCount, 15000) })
        .build();
      hubRef.current = hub;

      hub.on('MessageReceived', (m: MessageDto) => void onReceived(m).catch(report));
      hub.on('MessageAcked', async (cid: string, ulid: string) => {
        await (await d.messages.findOne(cid).exec())?.patch({ id: ulid, status: 'sent' });
      });
      hub.on('MessageDeleted', async (_did: string, messageId: string) => {
        await (await d.messages.findOne({ selector: { id: messageId } }).exec())?.patch({ isDeleted: true });
      });
      hub.on('UserTyping', onTyping);
      hub.on('PresenceChanged', (uid: string, st: string) => setPresence((p) => ({ ...p, [uid]: st === 'online' })));
      hub.onreconnecting(() => setStatus('connecting'));
      hub.onreconnected(() => { setStatus('online'); void sync(); });

      const connect = async () => {
        while (!dead && hub!.state === HubConnectionState.Disconnected) {
          try { setStatus('connecting'); await hub!.start(); setStatus('online'); void sync(); return; }
          catch (e) { console.warn('hub start failed', e); setStatus('offline'); await sleep(3000); }
        }
      };
      hub.onclose(() => { setStatus('offline'); void connect(); });
      await connect();
    })();

    return () => {
      dead = true; window.removeEventListener('online', onNet);
      hub?.stop(); dbRef.current = null; hubRef.current = null; setDb(null); void closeDb();
    };
  }, [me.id]);

  // ---------- Действия интерфейса ----------
  const value: Chat = {
    db, dbError, error, status, typing, presence, renamed,
    setActive: (id) => {
      activeRef.current = id;
      if (id) void dbRef.current?.dialogs.findOne(id).exec().then((x) => x && (x.toJSON() as DialogDoc).unread && x.patch({ unread: 0 }));
    },
    send: (dialogId, text) => {
      const m: MessageDoc = {
        clientMessageId: newId(), id: '', dialogId, senderId: me.id, text,
        createdAt: Date.now(), status: 'pending', isDeleted: false,
      };
      // Optimistic UI: сообщение сразу попадает в локальную БД и на экран, сеть — потом
      dbRef.current!.messages.insert(m).then(() => push(m.clientMessageId)).catch(report);
    },
    retry: (m) => {
      void dbRef.current!.messages.findOne(m.clientMessageId).exec()
        .then((doc) => doc?.patch({ status: 'pending' })).then(() => push(m.clientMessageId)).catch(report);
    },
    remove: async (m) => {
      const doc = await dbRef.current!.messages.findOne(m.clientMessageId).exec();
      if (!doc) return;
      if (!m.id) { await doc.remove(); return; } // ещё не ушло на сервер
      await doc.patch({ isDeleted: true });
      try { await api.deleteMessage(m.id); }
      catch (e) { await doc.getLatest().patch({ isDeleted: false }); throw e; }
    },
    startDialog: async (user) => {
      const d = dbRef.current!;
      const have = plain<DialogDoc>(await d.dialogs.find().exec()).find((x) => x.peer.id === user.id);
      if (have) return have.id;
      // Диалог появляется в локальной БД мгновенно, на сервере создаётся, как только появится сеть
      const tempId = 'L' + user.id;
      await d.dialogs.upsert({ id: tempId, createdAt: Date.now(), peer: toPeer(user), unread: 0, pending: true });
      void materialize(tempId).catch((e) => console.warn('dialog will be created later', e));
      return tempId;
    },
    removeDialog: async (id) => { if (!isTemp(id)) await api.deleteDialog(id); await dropDialogLocal(id); },
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
