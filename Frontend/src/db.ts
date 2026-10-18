import { createRxDatabase, removeRxDatabase, type RxCollection, type RxDatabase, type RxJsonSchema } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import type { LocalMessage } from './types';

export type MsgDb = RxDatabase<{ messages: RxCollection<LocalMessage> }>;

// Первичный ключ — clientMessageId: сообщение можно сохранить до того, как сервер выдал ULID.
const schema: RxJsonSchema<LocalMessage> = {
  version: 0,
  primaryKey: 'clientMessageId',
  type: 'object',
  properties: {
    clientMessageId: { type: 'string', maxLength: 64 },
    id: { type: 'string', maxLength: 26 },
    dialogId: { type: 'string', maxLength: 26 },
    senderId: { type: 'string', maxLength: 26 },
    text: { type: 'string' },
    mediaUrl: { type: ['string', 'null'] },
    createdAt: { type: 'string', maxLength: 32 },
    status: { type: 'string', maxLength: 8 },
  },
  required: ['clientMessageId', 'id', 'dialogId', 'senderId', 'text', 'createdAt', 'status'],
  indexes: [['dialogId', 'createdAt']],
};

const name = (userId: string) => `msgr_${userId.toLowerCase()}`;
const cache = new Map<string, Promise<MsgDb>>();

export function openDb(userId: string): Promise<MsgDb> {
  let p = cache.get(userId);
  if (!p) {
    p = (async () => {
      const db = await createRxDatabase<{ messages: RxCollection<LocalMessage> }>({
        name: name(userId),
        storage: getRxStorageDexie(),
      });
      await db.addCollections({ messages: { schema } });
      return db as MsgDb;
    })();
    cache.set(userId, p);
  }
  return p;
}

/** При выходе локальная история удаляется: на общем компьютере её не должно остаться. */
export async function dropDb(userId: string) {
  const p = cache.get(userId);
  cache.delete(userId);
  if (p) await (await p).close().catch(() => {});
  await removeRxDatabase(name(userId), getRxStorageDexie()).catch(() => {});
}
