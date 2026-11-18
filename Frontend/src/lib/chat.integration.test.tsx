// @vitest-environment jsdom
// Интеграционный тест ChatProvider: настоящие RxDB (IndexedDB в памяти) + api (fetch подменён) + логика синхронизации;
// подменены только сам SignalR (FakeHub), сессия, тосты и звук.
import '../test/setup';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFetch, json } from '../test/http';
import { sortMessages } from './format';
import type { DialogDoc, DialogDto, MessageDoc, MessageDto } from '../types';

// ---- подмены ----
const mocks = vi.hoisted(() => ({
  hubs: [] as any[],
  invoke: (_m: string, _a: any[]): any => undefined,
  me: { id: 'ME', login: 'me', displayName: 'Я', avatarUrl: null as string | null },
  toast: vi.fn(),
  beep: vi.fn(),
  showDesktop: vi.fn(),
}));

vi.mock('@microsoft/signalr', () => {
  const HubConnectionState = { Disconnected: 'Disconnected', Connecting: 'Connecting', Connected: 'Connected', Reconnecting: 'Reconnecting', Disconnecting: 'Disconnecting' };
  class FakeHub {
    state = 'Disconnected';
    handlers = new Map<string, ((...a: any[]) => any)[]>();
    invokes: any[][] = [];
    sent: any[][] = [];
    on(name: string, fn: (...a: any[]) => any) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); }
    onreconnecting() {} onreconnected() {} onclose() {}
    async start() { this.state = 'Connected'; }
    async stop() { this.state = 'Disconnected'; }
    async invoke(method: string, ...args: any[]) { this.invokes.push([method, ...args]); return mocks.invoke(method, args); }
    async send(method: string, ...args: any[]) { this.sent.push([method, ...args]); }
    emit(name: string, ...args: any[]) { return Promise.all((this.handlers.get(name) ?? []).map((f) => f(...args))); }
  }
  class HubConnectionBuilder {
    withUrl() { return this; }
    withAutomaticReconnect() { return this; }
    build() { const h = new FakeHub(); mocks.hubs.push(h); return h; }
  }
  return { HubConnectionBuilder, HubConnectionState };
});
vi.mock('./auth', () => ({ useAuth: () => ({ session: { token: 't', expiresAt: '', user: mocks.me } }) }));
vi.mock('../components/ui', () => ({ useToast: () => mocks.toast }));
vi.mock('./notify', () => ({ beep: mocks.beep, showDesktop: mocks.showDesktop, getNotifyPrefs: () => ({ sound: true, desktop: false }) }));

import { ChatProvider, useChat, useLiveQuery } from './chat';

// ---- данные ----
const ulid = (n: number) => 'M' + String(n).padStart(25, '0');   // 26 символов, без I/L/O/U, сортируется как число
const PEER = { id: 'PEER1', login: 'bob', displayName: 'Боб', avatarUrl: null };
let counter = 0;

const dto = (n: number, over: Partial<MessageDto> = {}): MessageDto => ({
  id: ulid(n), clientMessageId: 'c' + n, dialogId: 'D1', senderId: PEER.id, text: `сообщение ${n}`, mediaUrl: null,
  createdAt: new Date(1_700_000_000_000 + n * 1000).toISOString(), editedAt: null, kind: 'text', ...over,
});
const dialogDto = (over: Partial<DialogDto> = {}): DialogDto => ({
  id: 'D1', createdAt: new Date(1_700_000_000_000).toISOString(), peer: PEER, lastMessage: null, unreadCount: 0,
  peerLastReadId: null, kind: 'direct', memberCount: 2, myRole: 'member', ...over,
});

const server = { dialogs: [] as DialogDto[], messages: {} as Record<string, MessageDto[]>, deleteStatus: 200 };
let http: ReturnType<typeof installFetch>;
let visibility: 'visible' | 'hidden' = 'visible';

const defaultInvoke = (method: string): any => {
  if (method === 'GetOnlineContacts') return [];
  if (method === 'GetLastSeen') return {};
  if (method === 'SendMessage' || method === 'SendReply') return ulid(900 + counter++);
  return undefined;
};

function route({ url, method, body }: { url: URL; method: string; body: any }) {
  const p = url.pathname;
  if (method === 'GET' && p === '/api/dialogs') return json(200, url.searchParams.get('offset') === '0' ? server.dialogs : []);
  let m = p.match(/^\/api\/dialogs\/([^/]+)\/messages$/);
  if (m && method === 'GET') {
    const all = server.messages[m[1]] ?? [];
    const after = url.searchParams.get('after');
    const limit = Number(url.searchParams.get('limit') ?? 50);
    return json(200, after ? all.filter((x) => x.id > after).slice(0, limit) : all.slice(-limit));
  }
  if (method === 'GET' && /^\/api\/dialogs\/[^/]+\/(pins|reactions|members)$/.test(p)) return json(200, []);
  if (method === 'POST' && p === '/api/dialogs') {
    const created = dialogDto({ id: 'D9', peer: { id: body.userId, login: 'new', displayName: 'Новый', avatarUrl: null } });
    server.dialogs.push(created);   // дальше синхронизация видит новый диалог и не считает его удалённым
    return json(201, created);
  }
  m = p.match(/^\/api\/dialogs\/([^/]+)\/messages\/media$/);
  if (m && method === 'POST') {
    const f = body as FormData;
    return json(200, dto(800, { id: ulid(800), clientMessageId: String(f.get('clientMessageId')), senderId: mocks.me.id, dialogId: m[1], kind: String(f.get('kind')), mediaUrl: `/api/dialogs/${m[1]}/media/x.webp`, mediaWidth: 10, mediaHeight: 20 }));
  }
  if (method === 'DELETE' && p.startsWith('/api/messages/')) return server.deleteStatus === 200 ? json(204) : json(500, null);
  m = p.match(/^\/api\/messages\/([^/]+)$/);
  if (m && method === 'PUT') return json(200, dto(1, { id: m[1], text: body.text, editedAt: new Date().toISOString() }));
  m = p.match(/^\/api\/dialogs\/([^/]+)\/reactions\/([^/]+)$/);
  if (m && (method === 'PUT' || method === 'DELETE')) return json(204);
}

// ---- обвязка ----
let chat: ReturnType<typeof useChat>;
function Probe() {
  chat = useChat();
  const msgs = useLiveQuery<MessageDoc>((db) => db.messages.find({ selector: { dialogId: 'D1' } }), []);
  const dialogs = useLiveQuery<DialogDoc>((db) => db.dialogs.find(), []);
  return (
    <div>
      <span data-testid="status">{chat.status}</span>
      <span data-testid="dialogs">{dialogs.map((d) => d.id).sort().join(',')}</span>
      <span data-testid="unread">{dialogs.map((d) => `${d.id}:${d.unread}`).join(',')}</span>
      <span data-testid="peerRead">{dialogs.map((d) => d.peerRead).join(',')}</span>
      <span data-testid="presence">{JSON.stringify(chat.presence)}</span>
      <span data-testid="reactions">{JSON.stringify(chat.reactions)}</span>
      <span data-testid="renamed">{JSON.stringify(chat.renamed)}</span>
      <span data-testid="typing">{JSON.stringify(chat.typing)}</span>
      <ul>
        {[...msgs].sort(sortMessages).map((m) => (
          <li key={m.clientMessageId} data-status={m.status} data-deleted={String(m.isDeleted)} data-kind={m.kind} data-media={m.media} data-id={m.id}>{m.text}</li>
        ))}
      </ul>
    </div>
  );
}

let view: ReturnType<typeof render>;
const q = (id: string) => view.getByTestId(id).textContent;
const items = () => Array.from(view.container.querySelectorAll('li')).map((li) => li.textContent);
const item = (text: string) => Array.from(view.container.querySelectorAll('li')).find((li) => li.textContent === text);
const hub = () => mocks.hubs.at(-1);

async function mount() {
  view = render(<ChatProvider><Probe /></ChatProvider>);
  await waitFor(() => expect(hub()?.state).toBe('Connected'));
  await waitFor(() => expect(q('status')).toBe('online'));
  return hub();
}
/** Диалог D1 с двумя непрочитанными сообщениями собеседника уже синхронизирован. */
async function mountWithDialog() {
  server.messages.D1 = [dto(1), dto(2)];
  server.dialogs = [dialogDto({ lastMessage: dto(2), unreadCount: 2 })];
  const h = await mount();
  await waitFor(() => expect(items()).toEqual(['сообщение 1', 'сообщение 2']));
  await act(() => chat.resync());   // дожидаемся уже запущенных синхронизаций, чтобы они не перезаписали состояние посреди теста
  return h;
}

/** Ошибка, которой завершилось действие (null — завершилось успешно). */
async function failure(fn: () => Promise<unknown>): Promise<any> {
  let err: unknown = null;
  await act(async () => { try { await fn(); } catch (e) { err = e; } });
  return err;
}

beforeEach(() => {
  mocks.hubs.length = 0;
  mocks.invoke = defaultInvoke;
  mocks.me = { id: `ME${counter++}`, login: 'me', displayName: 'Я', avatarUrl: null };   // у каждого теста своя локальная БД
  mocks.toast.mockClear(); mocks.beep.mockClear(); mocks.showDesktop.mockClear();
  server.dialogs = []; server.messages = {}; server.deleteStatus = 200;
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  URL.createObjectURL = vi.fn(() => 'blob:test');
  http = installFetch(route);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.title = 'Мессенджер';
});
afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 30));   // даём завершиться хвосту синхронизации размонтированного провайдера
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('синхронизация при запуске', () => {
  it('подтягивает диалоги и историю с сервера в локальную базу', async () => {
    await mountWithDialog();

    expect(q('dialogs')).toBe('D1');
    expect(q('unread')).toBe('D1:2');
    expect(http.calls('GET', '/api/dialogs/D1/messages').length).toBeGreaterThan(0);
  });

  it('после подключения хаба запрашивает, кто онлайн, и когда были в сети остальные', async () => {
    mocks.invoke = (m) => (m === 'GetOnlineContacts' ? [PEER.id] : m === 'GetLastSeen' ? {} : undefined);

    const h = await mount();

    await waitFor(() => expect(JSON.parse(q('presence')!)).toEqual({ [PEER.id]: true }));
    expect(h.invokes.map((i: any[]) => i[0])).toEqual(expect.arrayContaining(['GetOnlineContacts', 'GetLastSeen']));
  });

  it('диалог, удалённый на сервере, пропадает локально вместе с сообщениями', async () => {
    await mountWithDialog();

    server.dialogs = [];
    await act(() => chat.resync());

    await waitFor(() => expect(q('dialogs')).toBe(''));
    expect(items()).toEqual([]);
  });

  it('при втором синхроне докачивает только новое (after = последний известный id)', async () => {
    await mountWithDialog();
    server.messages.D1 = [dto(1), dto(2), dto(3)];
    server.dialogs = [dialogDto({ lastMessage: dto(3), unreadCount: 3 })];

    await act(() => chat.resync());

    await waitFor(() => expect(items()).toEqual(['сообщение 1', 'сообщение 2', 'сообщение 3']));
    expect(http.calls('GET', '/api/dialogs/D1/messages').some((c) => c.url.searchParams.get('after') === ulid(2))).toBe(true);
  });
});

describe('входящие сообщения', () => {
  it('сообщение собеседника появляется, счётчик растёт, показан тост и звук', async () => {
    const h = await mountWithDialog();

    await act(() => h.emit('MessageReceived', dto(3, { text: 'новое' })));

    await waitFor(() => expect(items()).toContain('новое'));
    await waitFor(() => expect(q('unread')).toBe('D1:3'));
    expect(mocks.toast).toHaveBeenCalledWith('Боб: новое');
    expect(mocks.beep).toHaveBeenCalled();
  });

  it('вкладка скрыта: тост не показываем, звук есть', async () => {
    const h = await mountWithDialog();
    visibility = 'hidden';

    await act(() => h.emit('MessageReceived', dto(3, { text: 'новое' })));

    await waitFor(() => expect(q('unread')).toBe('D1:3'));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.beep).toHaveBeenCalled();
  });

  it('открытый и видимый диалог: без счётчика и уведомления, сразу «прочитано»', async () => {
    const h = await mountWithDialog();
    act(() => chat.setActive('D1'));
    await waitFor(() => expect(q('unread')).toBe('D1:0'));

    await act(() => h.emit('MessageReceived', dto(3, { text: 'новое' })));

    await waitFor(() => expect(items()).toContain('новое'));
    expect(q('unread')).toBe('D1:0');
    expect(mocks.toast).not.toHaveBeenCalled();
    await waitFor(() => expect(h.invokes).toContainEqual(['MarkRead', 'D1', ulid(3)]));
  });

  it('счётчик непрочитанных отражается в заголовке вкладки', async () => {
    await mountWithDialog();
    await waitFor(() => expect(document.title).toBe('(2) Мессенджер'));
  });

  it('служебное сообщение беседы не увеличивает счётчик и не шумит', async () => {
    const h = await mountWithDialog();

    await act(() => h.emit('MessageReceived', dto(3, { kind: 'system', text: 'Анна добавила Марка' })));

    await waitFor(() => expect(items()).toContain('Анна добавила Марка'));
    expect(q('unread')).toBe('D1:2');
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('сообщение из неизвестного диалога запускает синхронизацию', async () => {
    await mount();
    server.dialogs = [dialogDto({ lastMessage: dto(1), unreadCount: 1 })];
    server.messages.D1 = [dto(1)];

    await act(() => hub().emit('MessageReceived', dto(1)));

    await waitFor(() => expect(q('dialogs')).toBe('D1'));
  });

  it('эхо собственного сообщения подтверждает его, а не дублирует и не считается непрочитанным', async () => {
    const h = await mountWithDialog();
    act(() => chat.send('D1', 'привет'));
    await waitFor(() => expect(item('привет')?.getAttribute('data-status')).toBe('sent'));
    const cid = (h.invokes.find((i: any[]) => i[0] === 'SendMessage') as any[])[1];

    await act(() => h.emit('MessageReceived', dto(950, { clientMessageId: cid, senderId: mocks.me.id, text: 'привет' })));

    expect(items().filter((t) => t === 'привет')).toHaveLength(1);
    expect(q('unread')).toBe('D1:2');
  });
});

describe('отправка (Offline-First)', () => {
  it('сообщение сразу попадает в базу как pending, затем подтверждается сервером', async () => {
    const h = await mountWithDialog();

    act(() => chat.send('D1', 'привет'));

    await waitFor(() => expect(item('привет')).toBeDefined());
    await waitFor(() => expect(item('привет')?.getAttribute('data-status')).toBe('sent'));
    const call = h.invokes.find((i: any[]) => i[0] === 'SendMessage');
    expect(call.slice(2)).toEqual(['D1', 'привет']);
    expect(item('привет')?.getAttribute('data-id')).toMatch(/^M\d{25}$/);
  });

  it('ответ уходит методом SendReply с id исходного сообщения', async () => {
    const h = await mountWithDialog();

    act(() => chat.send('D1', 'ответ', ulid(1)));

    await waitFor(() => expect(h.invokes.some((i: any[]) => i[0] === 'SendReply')).toBe(true));
    expect(h.invokes.find((i: any[]) => i[0] === 'SendReply').slice(2)).toEqual(['D1', 'ответ', ulid(1)]);
  });

  it('сетевая ошибка: сообщение остаётся pending, повтор доставляет его', async () => {
    await mountWithDialog();
    mocks.invoke = (m) => { if (m === 'SendMessage') throw new Error('connection lost'); return defaultInvoke(m); };

    act(() => chat.send('D1', 'позже'));
    await waitFor(() => expect(hub().invokes.some((i: any[]) => i[0] === 'SendMessage')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(item('позже')?.getAttribute('data-status')).toBe('pending');

    mocks.invoke = defaultInvoke;
    const doc = (await chat.db!.messages.findOne({ selector: { text: 'позже' } }).exec())!.toJSON() as MessageDoc;
    act(() => chat.retry(doc));

    await waitFor(() => expect(item('позже')?.getAttribute('data-status')).toBe('sent'));
  });

  it('ошибка доступа от сервера: сообщение помечается failed и не зацикливается', async () => {
    await mountWithDialog();
    mocks.invoke = (m) => { if (m === 'SendMessage') throw new Error('forbidden'); return defaultInvoke(m); };

    act(() => chat.send('D1', 'нельзя'));

    await waitFor(() => expect(item('нельзя')?.getAttribute('data-status')).toBe('failed'));
  });

  it('ответ на удалённое сообщение отправляется как обычное, текст не теряется', async () => {
    const h = await mountWithDialog();
    mocks.invoke = (m) => { if (m === 'SendReply') throw new Error('invalid_reply_to'); return defaultInvoke(m); };

    act(() => chat.send('D1', 'всё равно скажу', ulid(1)));

    await waitFor(() => expect(item('всё равно скажу')?.getAttribute('data-status')).toBe('sent'));
    expect(h.invokes.some((i: any[]) => i[0] === 'SendMessage' && i[3] === 'всё равно скажу')).toBe(true);
  });

  it('фото уходит по REST (multipart), а не через хаб', async () => {
    const h = await mountWithDialog();

    act(() => chat.sendMedia('D1', 'image', new Blob(['x'], { type: 'image/webp' }), { width: 10, height: 20 }));

    await waitFor(() => expect(document.querySelector('li[data-kind="image"]')?.getAttribute('data-status')).toBe('sent'));
    const req = http.calls('POST', '/api/dialogs/D1/messages/media');
    expect(req).toHaveLength(1);
    expect((req[0].init!.body as FormData).get('kind')).toBe('image');
    expect(h.invokes.some((i: any[]) => i[0] === 'SendMessage')).toBe(false);
    expect(document.querySelector('li[data-kind="image"]')?.getAttribute('data-media')).toBe('/api/dialogs/D1/media/x.webp');
  });
});

describe('правка, удаление, реакции', () => {
  const mineSent = async () => {
    server.messages.D1 = [dto(1), dto(2, { senderId: mocks.me.id, text: 'моё' })];
    server.dialogs = [dialogDto({ lastMessage: dto(2), unreadCount: 0 })];
    await mount();
    await waitFor(() => expect(items()).toEqual(['сообщение 1', 'моё']));
    return (await chat.db!.messages.findOne({ selector: { text: 'моё' } }).exec())!.toJSON() as MessageDoc;
  };

  it('удаление чужого события MessageDeleted помечает сообщение удалённым', async () => {
    const h = await mountWithDialog();

    await act(() => h.emit('MessageDeleted', 'D1', ulid(1)));

    await waitFor(() => expect(item('сообщение 1')?.getAttribute('data-deleted')).toBe('true'));
    expect(item('сообщение 2')?.getAttribute('data-deleted')).toBe('false');
  });

  it('MessageEdited меняет текст', async () => {
    const h = await mountWithDialog();

    await act(() => h.emit('MessageEdited', dto(1, { text: 'исправлено', editedAt: new Date().toISOString() })));

    await waitFor(() => expect(items()).toContain('исправлено'));
  });

  it('remove(all): помечает удалённым и вызывает DELETE ?scope=all', async () => {
    const m = await mineSent();

    await act(() => chat.remove(m, 'all'));

    expect(item('моё')?.getAttribute('data-deleted')).toBe('true');
    const req = http.calls('DELETE', `/api/messages/${m.id}`);
    expect(req).toHaveLength(1);
    expect(req[0].url.searchParams.get('scope')).toBe('all');
  });

  it('remove: сервер отказал → удаление откатывается, ошибка наружу', async () => {
    const m = await mineSent();
    server.deleteStatus = 500;

    expect(await failure(() => chat.remove(m, 'all'))).toMatchObject({ status: 500 });

    await waitFor(() => expect(item('моё')?.getAttribute('data-deleted')).toBe('false'));
  });

  it('remove неотправленного сообщения стирает его локально, без запроса к серверу', async () => {
    await mountWithDialog();
    mocks.invoke = (m) => { if (m === 'SendMessage') throw new Error('connection lost'); return defaultInvoke(m); };
    act(() => chat.send('D1', 'черновик'));
    await waitFor(() => expect(item('черновик')?.getAttribute('data-status')).toBe('pending'));
    const doc = (await chat.db!.messages.findOne({ selector: { text: 'черновик' } }).exec())!.toJSON() as MessageDoc;

    await act(() => chat.remove(doc, 'all'));

    await waitFor(() => expect(item('черновик')).toBeUndefined());
    expect(http.calls('DELETE', '/api/messages')).toHaveLength(0);
  });

  it('edit: отправляет PUT и обновляет текст; пустой или тот же текст игнорируется', async () => {
    const m = await mineSent();

    await act(() => chat.edit(m, '   '));
    await act(() => chat.edit(m, 'моё'));
    expect(http.calls('PUT', '/api/messages/')).toHaveLength(0);

    await act(() => chat.edit(m, ' новый текст '));

    await waitFor(() => expect(items()).toContain('новый текст'));
    expect(http.calls('PUT', '/api/messages/')[0].init!.body).toBe(JSON.stringify({ text: 'новый текст' }));
  });

  it('реакции: событие хаба и своя реакция попадают в состояние, снятие убирает', async () => {
    const h = await mountWithDialog();
    const m = (await chat.db!.messages.findOne({ selector: { text: 'сообщение 1' } }).exec())!.toJSON() as MessageDoc;

    await act(() => h.emit('ReactionChanged', 'D1', ulid(1), PEER.id, '🔥'));
    expect(JSON.parse(q('reactions')!)).toEqual({ [ulid(1)]: { [PEER.id]: '🔥' } });

    await act(() => chat.react(m, '👍'));
    expect(JSON.parse(q('reactions')!)[ulid(1)][mocks.me.id]).toBe('👍');
    expect(http.calls('PUT', `/api/dialogs/D1/reactions/${ulid(1)}`)).toHaveLength(1);

    await act(() => chat.react(m, null));
    await act(() => h.emit('ReactionChanged', 'D1', ulid(1), PEER.id, null));
    expect(JSON.parse(q('reactions')!)).toEqual({});
    expect(http.calls('DELETE', `/api/dialogs/D1/reactions/${ulid(1)}`)).toHaveLength(1);
  });
});

describe('присутствие, «прочитано», «печатает»', () => {
  it('PresenceChanged переключает онлайн', async () => {
    const h = await mountWithDialog();

    await act(() => h.emit('PresenceChanged', PEER.id, 'online', null));
    await waitFor(() => expect(JSON.parse(q('presence')!)[PEER.id]).toBe(true));

    await act(() => h.emit('PresenceChanged', PEER.id, 'offline', new Date().toISOString()));
    await waitFor(() => expect(JSON.parse(q('presence')!)[PEER.id]).toBe(false));
  });

  it('MessagesRead от собеседника сдвигает маркер прочтения', async () => {
    const h = await mountWithDialog();

    await act(() => h.emit('MessagesRead', 'D1', PEER.id, ulid(5)));

    await waitFor(() => expect(q('peerRead')).toBe(ulid(5)));
    await act(() => h.emit('MessagesRead', 'D1', PEER.id, ulid(3)));   // назад не двигаем
    expect(q('peerRead')).toBe(ulid(5));
  });

  it('MessagesRead от меня (другое устройство) обнуляет счётчик', async () => {
    const h = await mountWithDialog();
    expect(q('unread')).toBe('D1:2');

    await act(() => h.emit('MessagesRead', 'D1', mocks.me.id, ulid(2)));

    await waitFor(() => expect(q('unread')).toBe('D1:0'));
  });

  it('открытие диалога отправляет MarkRead до последнего входящего, повторно — не шлёт', async () => {
    const h = await mountWithDialog();

    act(() => chat.setActive('D1'));
    await waitFor(() => expect(h.invokes.filter((i: any[]) => i[0] === 'MarkRead')).toEqual([['MarkRead', 'D1', ulid(2)]]));
    act(() => chat.setActive('D1'));
    await new Promise((r) => setTimeout(r, 50));

    expect(h.invokes.filter((i: any[]) => i[0] === 'MarkRead')).toHaveLength(1);
  });

  it('UserTyping от собеседника включает «печатает», от меня — игнорируется', async () => {
    const h = await mountWithDialog();

    await act(() => h.emit('UserTyping', 'D1', mocks.me.id));
    expect(q('typing')).toBe('{}');

    await act(() => h.emit('UserTyping', 'D1', PEER.id));
    await waitFor(() => expect(JSON.parse(q('typing')!)).toEqual({ D1: true }));
  });

  it('notifyTyping шлёт Typing не чаще раза в 2 секунды', async () => {
    const h = await mountWithDialog();

    act(() => { chat.notifyTyping('D1'); chat.notifyTyping('D1'); chat.notifyTyping('D1'); });

    expect(h.sent.filter((s: any[]) => s[0] === 'Typing')).toEqual([['Typing', 'D1']]);
  });
});

describe('диалоги', () => {
  it('startDialog создаёт временный диалог мгновенно, затем заменяет его серверным', async () => {
    await mount();
    const user = { id: 'NEWUSER', login: 'new', displayName: 'Новый', avatarUrl: null };

    let tempId = '';
    await act(async () => { tempId = await chat.startDialog(user); });

    expect(tempId).toBe('LNEWUSER');
    await waitFor(() => expect(q('dialogs')).toBe('D9'));
    expect(JSON.parse(q('renamed')!)).toEqual({ LNEWUSER: 'D9' });
    expect(http.calls('POST', '/api/dialogs')[0].init!.body).toBe(JSON.stringify({ userId: 'NEWUSER' }));
  });

  it('startDialog с уже существующим собеседником возвращает его диалог, ничего не создавая', async () => {
    await mountWithDialog();

    let id = '';
    await act(async () => { id = await chat.startDialog(PEER); });

    expect(id).toBe('D1');
    expect(http.calls('POST', '/api/dialogs')).toHaveLength(0);
  });

  it('removeDialog удаляет на сервере и локально', async () => {
    await mountWithDialog();
    http.fn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if ((init?.method ?? 'GET') === 'DELETE' && url.pathname === '/api/dialogs/D1') return json(204);
      return route({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body }) ?? json(404, null);
    });

    await act(() => chat.removeDialog('D1'));

    expect(q('dialogs')).toBe('');
    expect(items()).toEqual([]);
  });

  it('беседа: не владелец выходит (members/me), а не удаляет её у всех', async () => {
    server.dialogs = [dialogDto({ id: 'G1', kind: 'group', memberCount: 3, myRole: 'member' })];
    await mount();
    await waitFor(() => expect(q('dialogs')).toBe('G1'));
    http.fn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      return (init?.method ?? 'GET') === 'DELETE' ? json(204) : (route({ url, method: init?.method ?? 'GET', body: undefined }) ?? json(404, null));
    });

    await act(() => chat.removeDialog('G1'));

    expect(http.calls('DELETE', '/api/dialogs/G1/members/me')).toHaveLength(1);
    expect(http.calls('DELETE', '/api/dialogs/G1').filter((c) => !c.url.pathname.includes('/members'))).toHaveLength(0);
  });
});
