// @vitest-environment jsdom
// Интеграционный тест: настоящие AuthProvider + api + persist, сервер подменён через fetch.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFetch, json } from '../test/http';
import * as api from './api';
import { AuthProvider, useAuth } from './auth';

const USER = { id: 'u1', login: 'ann', displayName: 'Анна', avatarUrl: null };
const AUTH = { accessToken: 'tok-secret-1', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), user: USER };

let auth: ReturnType<typeof useAuth>;
function Probe() {
  auth = useAuth();
  return <div data-testid="who">{auth.session ? `${auth.session.user.displayName}|${auth.session.token}` : 'anon'}</div>;
}
const mount = () => render(<AuthProvider><Probe /></AuthProvider>);
const who = async () => (await screen.findByTestId('who')).textContent;

beforeEach(() => {
  localStorage.clear();
  api.setToken(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('запуск приложения', () => {
  it('без прежнего входа: форма входа, запросов к серверу нет', async () => {
    const srv = installFetch(() => json(500));

    mount();

    expect(await who()).toBe('anon');
    expect(srv.fn).not.toHaveBeenCalled();
  });

  it('есть сохранённый пользователь → сессия восстанавливается по refresh-cookie', async () => {
    localStorage.setItem('session:user', JSON.stringify(USER));
    const srv = installFetch(({ url }) => (url.pathname === '/api/auth/refresh' ? json(200, AUTH) : undefined));

    mount();

    expect(await who()).toBe('Анна|tok-secret-1');
    expect(srv.calls('POST', '/api/auth/refresh')).toHaveLength(1);
    expect(api.getToken()).toBe('tok-secret-1');
  });

  it('в localStorage не попадает токен, только профиль', async () => {
    localStorage.setItem('session:user', JSON.stringify(USER));
    installFetch(({ url }) => (url.pathname === '/api/auth/refresh' ? json(200, AUTH) : undefined));

    mount();
    await who();

    const dump = JSON.stringify({ ...localStorage });
    expect(dump).not.toContain('tok-secret-1');
    expect(JSON.parse(localStorage.getItem('session:user')!)).toEqual(USER);
  });

  it('сессия закончилась на сервере → выход и очистка ui-состояния, настройки остаются', async () => {
    localStorage.setItem('session:user', JSON.stringify(USER));
    localStorage.setItem('ui:tab', '"people"');
    localStorage.setItem('pref:notify', '{"sound":false}');
    installFetch(() => json(401, null));

    mount();

    expect(await who()).toBe('anon');
    expect(localStorage.getItem('session:user')).toBeNull();
    expect(localStorage.getItem('ui:tab')).toBeNull();
    expect(localStorage.getItem('pref:notify')).toBe('{"sound":false}');
  });

  it('нет сети при запуске → интерфейс открывается из локальных данных с пустым токеном', async () => {
    localStorage.setItem('session:user', JSON.stringify(USER));
    installFetch(() => { throw new TypeError('offline'); });

    mount();

    expect(await who()).toBe('Анна|');
    expect(localStorage.getItem('session:user')).not.toBeNull();   // пользователя не «выкидываем» из-за сети
  });
});

describe('вход, регистрация, выход', () => {
  it('login обрезает пробелы в логине, сохраняет профиль и токен в памяти', async () => {
    const srv = installFetch(({ url }) => (url.pathname === '/api/auth/login' ? json(200, AUTH) : undefined));
    mount();
    await who();

    await act(() => auth.login('  ann  ', 'secret'));

    expect(await who()).toBe('Анна|tok-secret-1');
    expect(srv.calls('POST', '/api/auth/login')[0].init!.body).toBe(JSON.stringify({ login: 'ann', password: 'secret' }));
    expect(JSON.parse(localStorage.getItem('session:user')!).login).toBe('ann');
  });

  it('неверный пароль: ошибка наружу, сессии нет', async () => {
    installFetch(() => json(401, null));
    mount();
    await who();

    await expect(act(() => auth.login('ann', 'bad'))).rejects.toMatchObject({ status: 401 });

    expect(await who()).toBe('anon');
    expect(localStorage.getItem('session:user')).toBeNull();
  });

  it('register обрезает логин и email', async () => {
    const srv = installFetch(({ url }) => (url.pathname === '/api/auth/register' ? json(200, AUTH) : undefined));
    mount();
    await who();

    await act(() => auth.register({ login: ' ann ', email: ' ann@x.io ', password: 'secret12', displayName: 'Анна' }));

    expect(JSON.parse(srv.calls('POST', '/api/auth/register')[0].init!.body as string)).toMatchObject({ login: 'ann', email: 'ann@x.io' });
  });

  it('logout сообщает серверу, сбрасывает токен и чистит состояние интерфейса', async () => {
    localStorage.setItem('session:user', JSON.stringify(USER));
    localStorage.setItem('ui:tab', '"people"');
    const srv = installFetch(({ url }) => {
      if (url.pathname === '/api/auth/refresh') return json(200, AUTH);
      if (url.pathname === '/api/auth/logout') return json(204);
    });
    mount();
    expect(await who()).toBe('Анна|tok-secret-1');

    act(() => auth.logout());

    await waitFor(async () => expect(await who()).toBe('anon'));
    expect(api.getToken()).toBeNull();
    expect(localStorage.getItem('session:user')).toBeNull();
    expect(localStorage.getItem('ui:tab')).toBeNull();
    expect(srv.calls('POST', '/api/auth/logout')).toHaveLength(1);
  });

  it('logout не падает, даже если сервер недоступен', async () => {
    localStorage.setItem('session:user', JSON.stringify(USER));
    installFetch(({ url }) => {
      if (url.pathname === '/api/auth/refresh') return json(200, AUTH);
      throw new TypeError('offline');
    });
    mount();
    await who();

    act(() => auth.logout());

    await waitFor(async () => expect(await who()).toBe('anon'));
  });
});

describe('профиль', () => {
  it('updateProfile обновляет пользователя в сессии', async () => {
    localStorage.setItem('session:user', JSON.stringify(USER));
    installFetch(({ url, method }) => {
      if (url.pathname === '/api/auth/refresh') return json(200, AUTH);
      if (url.pathname === '/api/users/me' && method === 'PUT') return json(200, { ...USER, displayName: 'Анна Новая', bio: null, createdAt: '2026-01-01T00:00:00Z' });
    });
    mount();
    await who();

    await act(() => auth.updateProfile({ displayName: 'Анна Новая', avatarUrl: null }));

    expect(await who()).toBe('Анна Новая|tok-secret-1');
    expect(JSON.parse(localStorage.getItem('session:user')!).displayName).toBe('Анна Новая');
  });
});
