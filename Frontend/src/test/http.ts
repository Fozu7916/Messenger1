import { vi } from 'vitest';

/** Ответ fetch: JSON (или пустое тело, если body не передан). */
export const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  });

export interface FakeRequest { url: URL; method: string; body: any; headers: Headers }
/** Вернуть Response, чтобы обработать запрос; undefined — «такого маршрута нет» (ответ 404). */
export type Handler = (req: FakeRequest) => Response | Promise<Response> | undefined;

/** Подменяет глобальный fetch: запросы разбираются обработчиком, все вызовы записываются. */
export function installFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const res = await handler({ url, method: init?.method ?? 'GET', body, headers: new Headers(init?.headers) });
    return res ?? json(404, null);
  });
  vi.stubGlobal('fetch', fn);
  return {
    fn,
    /** Записанные запросы выбранного метода и пути (путь — префикс). */
    calls: (method: string, path: string) =>
      fn.mock.calls
        .map(([u, i]) => ({ url: new URL(String(u), 'http://localhost'), method: (i as RequestInit | undefined)?.method ?? 'GET', init: i as RequestInit | undefined }))
        .filter((c) => c.method === method && c.url.pathname.startsWith(path)),
  };
}
