// Интеграционный тест: настоящий RxDB + Dexie поверх IndexedDB в памяти (fake-indexeddb).
import '../test/setup';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from './db';
import type { DialogDoc, MessageDoc } from '../types';

let n = 0;
const uid = () => `USER${Date.now().toString(36)}${n++}`;   // у каждого теста своя БД

const msg = (cid: string, over: Partial<MessageDoc> = {}): MessageDoc => ({
  clientMessageId: cid, id: '', dialogId: 'D1', senderId: 'U1', text: 'привет', createdAt: 1_700_000_000_000,
  status: 'pending', isDeleted: false, editedAt: 0, replyToId: '', fwdFrom: '', kind: 'text', media: '', mw: 0, mh: 0, dur: 0, ...over,
});
const dlg = (id: string, over: Partial<DialogDoc> = {}): DialogDoc => ({
  id, createdAt: 1_700_000_000_000, peer: { id: 'P1', login: 'bob', displayName: 'Боб', avatarUrl: '' },
  unread: 0, peerRead: '', pending: false, kind: 'direct', memberCount: 2, myRole: 'member', ...over,
});

afterEach(() => closeDb());

describe('локальная база (RxDB)', () => {
  it('сообщения и диалоги сохраняются и находятся по выборке', async () => {
    const db = await openDb(uid());
    await db.dialogs.insert(dlg('D1'));
    await db.messages.bulkInsert([msg('c1'), msg('c2', { dialogId: 'D2' })]);

    const inD1 = await db.messages.find({ selector: { dialogId: 'D1' } }).exec();

    expect(inD1.map((d) => d.clientMessageId)).toEqual(['c1']);
    expect((await db.dialogs.findOne('D1').exec())!.toJSON().peer.displayName).toBe('Боб');
  });

  it('данные переживают закрытие и повторное открытие', async () => {
    const user = uid();
    const db = await openDb(user);
    await db.messages.insert(msg('c1', { text: 'не потеряется' }));

    await closeDb();
    const again = await openDb(user);

    expect((await again.messages.findOne('c1').exec())!.text).toBe('не потеряется');
  });

  it('имя базы не зависит от регистра id пользователя', async () => {
    const user = uid();
    expect(await openDb(user.toUpperCase())).toBe(await openDb(user.toLowerCase()));
  });

  it('у каждого пользователя своя база', async () => {
    const a = uid(), b = uid();
    const dbA = await openDb(a);
    await dbA.messages.insert(msg('c1'));

    await closeDb();
    const dbB = await openDb(b);

    expect(await dbB.messages.find().exec()).toHaveLength(0);
    await closeDb();
    expect(await (await openDb(a)).messages.find().exec()).toHaveLength(1);
  });

  it('подтверждение отправки меняет то же сообщение (ключ — clientMessageId), дубля нет', async () => {
    const db = await openDb(uid());
    await db.messages.insert(msg('c1'));

    await (await db.messages.findOne('c1').exec())!.incrementalPatch({ id: 'M0000000000000000000000001', status: 'sent' });
    await db.messages.upsert(msg('c1', { id: 'M0000000000000000000000001', status: 'sent' }));   // эхо с сервера

    const all = await db.messages.find().exec();
    expect(all).toHaveLength(1);
    expect(all[0].toJSON()).toMatchObject({ id: 'M0000000000000000000000001', status: 'sent' });
  });

  it('живой запрос сообщает об изменениях', async () => {
    const db = await openDb(uid());
    const seen: number[] = [];
    const sub = db.messages.find({ selector: { dialogId: 'D1' } }).$.subscribe((docs) => seen.push(docs.length));

    await db.messages.insert(msg('c1'));
    await db.messages.insert(msg('c2'));
    await new Promise((r) => setTimeout(r, 50));
    sub.unsubscribe();

    expect(seen.at(-1)).toBe(2);
  });

  it('повторное открытие той же базы возвращает тот же экземпляр (защита от DB8 при горячей перезагрузке)', async () => {
    const user = uid();
    const [a, b] = await Promise.all([openDb(user), openDb(user)]);
    expect(a).toBe(b);
  });
});
