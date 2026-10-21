import { createRxDatabase, removeRxDatabase, type RxCollection, type RxDatabase, type RxJsonSchema } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import type { DialogDoc, MessageDoc } from '../types';

export type Collections = { messages: RxCollection<MessageDoc>; dialogs: RxCollection<DialogDoc> };
export type DB = RxDatabase<Collections>;

const messageSchema: RxJsonSchema<MessageDoc> = {
  version: 0, primaryKey: 'clientMessageId', type: 'object',
  properties: {
    clientMessageId: { type: 'string', maxLength: 64 },
    id: { type: 'string', maxLength: 26 },
    dialogId: { type: 'string', maxLength: 40 },
    senderId: { type: 'string', maxLength: 26 },
    text: { type: 'string', maxLength: 4000 },
    createdAt: { type: 'number' },
    status: { type: 'string', maxLength: 10 },
    isDeleted: { type: 'boolean' },
  },
  required: ['clientMessageId', 'id', 'dialogId', 'senderId', 'text', 'createdAt', 'status', 'isDeleted'],
  indexes: ['dialogId'],
};

const dialogSchema: RxJsonSchema<DialogDoc> = {
  version: 0, primaryKey: 'id', type: 'object',
  properties: {
    id: { type: 'string', maxLength: 40 },
    createdAt: { type: 'number' },
    peer: {
      type: 'object',
      properties: { id: { type: 'string' }, login: { type: 'string' }, displayName: { type: 'string' }, avatarUrl: { type: 'string' } },
      required: ['id', 'login', 'displayName', 'avatarUrl'],
    },
    unread: { type: 'number' },
    pending: { type: 'boolean' },
  },
  required: ['id', 'createdAt', 'peer', 'unread', 'pending'],
};

// Отдельная локальная БД на каждого пользователя (IndexedDB через Dexie).
// Префикс messenger2- — схема изменилась, старая БД «messenger-…» больше не используется.
// Состояние лежит в globalThis: при горячей перезагрузке модулей Vite экземпляр БД переиспользуется,
// иначе RxDB ругается на повторное создание БД с тем же именем (DB8).
interface Holder { cache: { name: string; p: Promise<DB> } | null; closing: Promise<void> }
const g = globalThis as unknown as { __messengerDb?: Holder };
const S: Holder = (g.__messengerDb ??= { cache: null, closing: Promise.resolve() });

const create = async (name: string): Promise<DB> => {
  const db = await createRxDatabase<Collections>({ name, storage: getRxStorageDexie() });
  await db.addCollections({ messages: { schema: messageSchema }, dialogs: { schema: dialogSchema } });
  return db;
};

export async function openDb(userId: string): Promise<DB> {
  await S.closing;
  const name = 'messenger2-' + userId.toLowerCase();
  if (S.cache?.name === name) return S.cache.p;
  const p = create(name).catch(async (e) => {
    // Повреждённую БД или несовпавшую схему пересоздаём (копия восстановится с сервера).
    // DB8/DB9 — это не повреждение, а повторное открытие: их пересозданием не лечим.
    const code = (e as { code?: string })?.code;
    if (code === 'DB8' || code === 'DB9') throw e;
    console.error('RxDB open failed, recreating', e);
    await removeRxDatabase(name, getRxStorageDexie());
    return create(name);
  });
  S.cache = { name, p };
  p.catch(() => { if (S.cache?.p === p) S.cache = null; });
  return p;
}

export function closeDb(): Promise<void> {
  const c = S.cache; S.cache = null;
  S.closing = (async () => { if (c) { try { await (await c.p).close(); } catch { /* ignore */ } } })();
  return S.closing;
}
