import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json } from '../test/http';

type Api = typeof import('./api');
let api: Api;
const fetchMock = vi.fn();

const AUTH = { accessToken: 'new', expiresAt: '2030-01-01T00:00:00Z', user: { id: 'u1', login: 'ann', displayName: 'Анна', avatarUrl: null } };
const call = (i: number) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url: String(url), init, headers: new Headers(init?.headers) };
};

beforeEach(async () => {
  vi.resetModules();   // у модуля есть состояние (токен, общий refresh) — каждому тесту нужен чистый
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  api = await import('./api');
});
afterEach(() => vi.unstubAllGlobals());

describe('api: запросы', () => {
  it('login шлёт JSON с куками и без Authorization, пока токена нет', async () => {
    fetchMock.mockResolvedValue(json(200, AUTH));

    const r = await api.login('ann', 'secret');

    expect(r.user.login).toBe('ann');
    const c = call(0);
    expect(c.url).toBe('/api/auth/login');
    expect(c.init.method).toBe('POST');
    expect(c.init.credentials).toBe('include');
    expect(c.headers.get('Content-Type')).toBe('application/json');
    expect(c.headers.get('Authorization')).toBeNull();
    expect(JSON.parse(c.init.body as string)).toEqual({ login: 'ann', password: 'secret' });
  });

  it('после setToken добавляет Bearer', async () => {
    api.setToken('abc');
    fetchMock.mockResolvedValue(json(200, { id: 'u1' }));

    await api.me();

    expect(call(0).headers.get('Authorization')).toBe('Bearer abc');
    expect(api.getToken()).toBe('abc');
  });

  it('204 даёт undefined, а не ошибку разбора JSON', async () => {
    fetchMock.mockResolvedValue(json(204));
    await expect(api.logout()).resolves.toBeUndefined();
  });

  it('FormData уходит как есть, без Content-Type (границу ставит браузер)', async () => {
    fetchMock.mockResolvedValue(json(200, { id: 'u1' }));

    await api.uploadAvatar(new File(['x'], 'a.png', { type: 'image/png' }));

    const c = call(0);
    expect(c.init.body).toBeInstanceOf(FormData);
    expect(c.headers.get('Content-Type')).toBeNull();
  });
});

describe('api: тексты ошибок', () => {
  it('берёт первую ошибку валидации из problem+json', async () => {
    fetchMock.mockResolvedValue(json(400, { errors: { Password: ['Пароль слишком короткий', 'другое'] } }));
    await expect(api.login('a', 'b')).rejects.toMatchObject({ status: 400, message: 'Пароль слишком короткий' });
  });

  it('иначе берёт detail', async () => {
    fetchMock.mockResolvedValue(json(400, { detail: 'Плохой запрос' }));
    await expect(api.login('a', 'b')).rejects.toMatchObject({ message: 'Плохой запрос' });
  });

  it.each([
    [409, 'Такой логин или email уже занят'],
    [413, 'Файл слишком большой'],
    [404, 'Не найдено'],
    [500, 'Сервер недоступен, попробуйте позже'],
    [418, 'Что-то пошло не так'],
  ])('без тела: статус %i → «%s»', async (status, text) => {
    fetchMock.mockResolvedValue(json(status, null));
    await expect(api.login('a', 'b')).rejects.toMatchObject({ status, message: text });
  });

  it('не-JSON ответ (например, страница 502 от прокси) не ломает обработку', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(api.login('a', 'b')).rejects.toMatchObject({ status: 502, message: 'Сервер недоступен, попробуйте позже' });
  });

  it('429 подставляет Retry-After', async () => {
    fetchMock.mockResolvedValue(json(429, null, { 'Retry-After': '7' }));
    await expect(api.login('a', 'b')).rejects.toMatchObject({ status: 429, message: expect.stringContaining('7 с') });
  });

  it('429 без Retry-After — общий текст', async () => {
    fetchMock.mockResolvedValue(json(429, null));
    await expect(api.login('a', 'b')).rejects.toMatchObject({ status: 429, message: 'Слишком много запросов — подождите минуту' });
  });

  it('нет сети → ApiError со статусом 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.me()).rejects.toMatchObject({ name: 'Error', status: 0, message: 'Нет соединения с сервером' });
    await expect(api.me()).rejects.toBeInstanceOf(api.ApiError);
  });
});

describe('api: обновление токена', () => {
  const dataByToken = (profile: unknown) => async (url: string, init: RequestInit) => {
    if (String(url) === '/api/auth/refresh') return json(200, AUTH);
    return new Headers(init.headers).get('Authorization') === 'Bearer new' ? json(200, profile) : json(401, null);
  };

  it('401 → тихий refresh → повтор запроса с новым токеном', async () => {
    api.setToken('old');
    const onRefreshed = vi.fn();
    api.setRefreshedHandler(onRefreshed);
    fetchMock.mockImplementation(dataByToken({ id: 'u1' }));

    const r = await api.me();

    expect(r).toEqual({ id: 'u1' });
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual(['/api/users/me', '/api/auth/refresh', '/api/users/me']);
    expect(call(1).headers.get('X-Requested-With')).toBe('fetch');   // защита refresh от CSRF
    expect(call(1).init.credentials).toBe('include');
    expect(api.getToken()).toBe('new');
    expect(onRefreshed).toHaveBeenCalledWith(AUTH);
  });

  it('параллельные запросы с истёкшим токеном делят один refresh', async () => {
    api.setToken('old');
    fetchMock.mockImplementation(dataByToken({ id: 'u1' }));

    await Promise.all([api.me(), api.me(), api.me()]);

    expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/auth/refresh')).toHaveLength(1);
  });

  it('refresh не удался (сессия закончилась) → onUnauthorized и ошибка 401', async () => {
    api.setToken('old');
    const onUnauthorized = vi.fn();
    api.setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockImplementation(async (url: string) => (String(url) === '/api/auth/refresh' ? json(401, null) : json(401, null)));

    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('refresh не дошёл до сервера (нет сети) → сессию не сбрасываем', async () => {
    api.setToken('old');
    const onUnauthorized = vi.fn();
    api.setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === '/api/auth/refresh') throw new TypeError('offline');
      return json(401, null);
    });

    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('после повтора снова 401 → onUnauthorized, без бесконечного цикла', async () => {
    api.setToken('old');
    const onUnauthorized = vi.fn();
    api.setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockImplementation(async (url: string) => (String(url) === '/api/auth/refresh' ? json(200, AUTH) : json(401, null)));

    await expect(api.me()).rejects.toMatchObject({ status: 401 });

    expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/auth/refresh')).toHaveLength(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('401 на /api/auth/* (неверный пароль) не запускает refresh', async () => {
    api.setToken('old');
    fetchMock.mockResolvedValue(json(401, null));

    await expect(api.login('a', 'wrong')).rejects.toMatchObject({ status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401])('refresh(): статус %i → null', async (status) => {
    fetchMock.mockResolvedValue(json(status, null));
    await expect(api.refresh()).resolves.toBeNull();
  });

  it('refresh(): 500 → ApiError, нет сети → ApiError(0)', async () => {
    fetchMock.mockResolvedValueOnce(json(500, null));
    await expect(api.refresh()).rejects.toMatchObject({ status: 500 });
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(api.refresh()).rejects.toMatchObject({ status: 0 });
  });
});

describe('api: пути и параметры', () => {
  beforeEach(() => fetchMock.mockImplementation(async () => json(200, [])));

  it('users: пустые параметры не попадают в строку запроса', async () => {
    await api.users();
    await api.users({ query: 'ан', offset: 20, limit: 10 });
    expect(call(0).url).toBe('/api/users?');
    expect(call(1).url).toBe('/api/users?query=%D0%B0%D0%BD&offset=20&limit=10');
  });

  it('searchUsers и searchMessages', async () => {
    await api.searchUsers('пет ив', { scope: 'contacts', limit: 5 });
    await api.searchMessages('привет', { dialogId: 'D1', before: 'B1', limit: 20 });
    const u1 = new URL(call(0).url, 'http://x');
    expect(u1.pathname).toBe('/api/users/search');
    expect(u1.searchParams.get('q')).toBe('пет ив');
    expect(u1.searchParams.get('scope')).toBe('contacts');
    const u2 = new URL(call(1).url, 'http://x');
    expect(u2.pathname).toBe('/api/messages/search');
    expect([u2.searchParams.get('dialogId'), u2.searchParams.get('before'), u2.searchParams.get('limit')]).toEqual(['D1', 'B1', '20']);
  });

  it('messages: after/before/limit', async () => {
    await api.messages('D1', { after: 'A', limit: 100 });
    const u = new URL(call(0).url, 'http://x');
    expect(u.pathname).toBe('/api/dialogs/D1/messages');
    expect([u.searchParams.get('after'), u.searchParams.get('before'), u.searchParams.get('limit')]).toEqual(['A', null, '100']);
  });

  it('deleteMessage по умолчанию удаляет у всех', async () => {
    fetchMock.mockResolvedValue(json(204));
    await api.deleteMessage('M1');
    await api.deleteMessage('M2', 'me');
    expect(call(0).url).toBe('/api/messages/M1?scope=all');
    expect(call(1).url).toBe('/api/messages/M2?scope=me');
  });

  it('removeMember("me") — выход из беседы', async () => {
    fetchMock.mockResolvedValue(json(204));
    await api.removeMember('G1', 'me');
    expect(call(0)).toMatchObject({ url: '/api/dialogs/G1/members/me' });
    expect(call(0).init.method).toBe('DELETE');
  });
});

describe('api: dialogs() собирает все страницы', () => {
  const page = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `D${from + i}` }));

  it('короткая первая страница — один запрос', async () => {
    fetchMock.mockResolvedValue(json(200, page(30)));
    expect(await api.dialogs()).toHaveLength(30);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('полная страница — запрашивает следующую с новым offset', async () => {
    fetchMock.mockResolvedValueOnce(json(200, page(100))).mockResolvedValueOnce(json(200, page(30, 100)));

    const all = await api.dialogs();

    expect(all).toHaveLength(130);
    expect(call(0).url).toBe('/api/dialogs?limit=100&offset=0');
    expect(call(1).url).toBe('/api/dialogs?limit=100&offset=100');
  });
});

describe('api: вложения', () => {
  it('sendMedia собирает multipart с нужными полями', async () => {
    fetchMock.mockResolvedValue(json(200, { id: 'M1' }));

    await api.sendMedia('D1', { clientMessageId: 'c1', kind: 'voice', file: new Blob(['x']), durationMs: 1234.6, replyToId: 'R1' });

    const c = call(0);
    expect(c.url).toBe('/api/dialogs/D1/messages/media');
    const f = c.init.body as FormData;
    expect([f.get('clientMessageId'), f.get('kind'), f.get('durationMs'), f.get('replyToId')]).toEqual(['c1', 'voice', '1235', 'R1']);
    expect(f.has('text')).toBe(false);   // пустые необязательные поля не отправляем
    expect(c.headers.get('Content-Type')).toBeNull();
  });

  it('authedBlob отдаёт Blob с токеном', async () => {
    api.setToken('t');
    fetchMock.mockResolvedValue(new Response(new Blob(['abc'], { type: 'image/webp' }), { status: 200 }));

    const b = await api.authedBlob('/api/dialogs/D1/media/x.webp');

    expect(await b.text()).toBe('abc');
    expect(call(0).headers.get('Authorization')).toBe('Bearer t');
  });

  it('authedBlob: 404 → ApiError', async () => {
    fetchMock.mockResolvedValue(json(404, null));
    await expect(api.authedBlob('/api/x')).rejects.toMatchObject({ status: 404, message: 'Не найдено' });
  });

  it('authedBlob: 401 → refresh → повтор', async () => {
    api.setToken('old');
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (String(url) === '/api/auth/refresh') return json(200, AUTH);
      return new Headers(init.headers).get('Authorization') === 'Bearer new' ? new Response(new Blob(['ok'])) : json(401, null);
    });

    expect(await (await api.authedBlob('/api/x')).text()).toBe('ok');
  });
});
