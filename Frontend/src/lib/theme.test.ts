// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Theme = typeof import('./theme');
let theme: Theme;
let token: string | null;
const putAppearance = vi.fn(async (_v: unknown) => {});
const getAppearance = vi.fn();

class ApiError extends Error { constructor(public status: number, m: string) { super(m); } }

const load = async (opts: { dark?: boolean } = {}) => {
  vi.resetModules();
  if (opts.dark !== undefined) {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: opts.dark, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  }
  vi.doMock('./api', () => ({ getToken: () => token, putAppearance, getAppearance, wallpaperBlob: vi.fn(), ApiError }));
  theme = await import('./theme');
};
const css = (name: string) => document.documentElement.style.getPropertyValue(name);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  token = null;
  putAppearance.mockClear();
  getAppearance.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.doUnmock('./api'); });

describe('загрузка оформления', () => {
  it('без сохранённого — значения по умолчанию', async () => {
    await load();
    expect(theme.getAppearance()).toEqual(theme.DEFAULTS);
  });

  it('переходит со старых отдельных ключей theme и accent', async () => {
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('accent', 'emerald');
    await load();
    expect(theme.getAppearance()).toMatchObject({ mode: 'dark', accent: 'emerald' });
  });

  it('повреждённое значение не ломает запуск', async () => {
    localStorage.setItem('appearance', '{oops');
    await load();
    expect(theme.getAppearance()).toEqual(theme.DEFAULTS);
  });

  it('чужие или устаревшие значения отбрасываются на загрузке', async () => {
    localStorage.setItem('appearance', JSON.stringify({ mode: 'neon', bubble: 'hex', font: 'comic', accent: 'red', fontScale: 'big', wallpaper: { kind: 'upload', id: '../../etc' } }));
    await load();
    expect(theme.getAppearance()).toEqual(theme.DEFAULTS);
  });
});

describe('update: проверка и применение', () => {
  beforeEach(() => load());

  it('размер шрифта ограничен диапазоном 0.85–1.3', () => {
    theme.update({ fontScale: 5 });
    expect(theme.getAppearance().fontScale).toBe(1.3);
    theme.update({ fontScale: 0.1 });
    expect(theme.getAppearance().fontScale).toBe(0.85);
  });

  it('акцент: свой цвет #rrggbb принимается, мусор заменяется на стандартный', () => {
    theme.update({ accent: '#aabbcc' });
    expect(theme.getAppearance().accent).toBe('#aabbcc');
    theme.update({ accent: 'url(javascript:alert(1))' });
    expect(theme.getAppearance().accent).toBe(theme.DEFAULTS.accent);
  });

  it('обои-картинка: id должен быть 26 символов; затемнение 0–0.6', () => {
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    theme.update({ wallpaper: { kind: 'upload', id, dim: 5 } });
    expect(theme.getAppearance().wallpaper).toEqual({ kind: 'upload', id, dim: 0.6 });
    theme.update({ wallpaper: { kind: 'upload', id: 'short', dim: 0.3 } });
    expect(theme.getAppearance().wallpaper).toEqual({ kind: 'preset', id: 'dots', dim: 0 });
  });

  it('неизвестный пресет обоев заменяется на стандартный', () => {
    theme.update({ wallpaper: { kind: 'preset', id: 'nope', dim: 0 } });
    expect(theme.getAppearance().wallpaper.id).toBe('dots');
  });

  it('сохраняет в localStorage и уведомляет подписчиков', () => {
    const listener = vi.fn();
    const off = theme.subscribe(listener);

    theme.update({ bubble: 'square' });

    expect(JSON.parse(localStorage.getItem('appearance')!).bubble).toBe('square');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    theme.update({ bubble: 'soft' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('применяет тему и переменные CSS к <html>', () => {
    theme.update({ mode: 'dark', accent: 'emerald', bubble: 'square', density: 'cozy', fontScale: 1.1, font: 'mono' });

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(css('--accent')).toBe('#4cc38a');
    expect(css('--br')).toBe('6px');
    expect(css('--msg-py')).toBe('13px');
    expect(css('--fs')).toBe('1.1');
    expect(css('--msg-font')).toContain('JetBrains Mono');

    theme.update({ mode: 'light' });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(css('--accent')).toBe('#1f7a52');
  });

  it('цвет текста на своём акценте подбирается по яркости', () => {
    theme.update({ accent: '#ffff00' });
    expect(css('--accent-ink')).toBe('#1c1a16');
    theme.update({ accent: '#101010' });
    expect(css('--accent-ink')).toBe('#ffffff');
  });

  it('reset возвращает значения по умолчанию', () => {
    theme.update({ mode: 'dark', bubble: 'square' });
    theme.reset();
    expect(theme.getAppearance()).toEqual(theme.DEFAULTS);
  });
});

describe('режим «авто» следует за системной темой', () => {
  it('тёмная система → тёмная тема', async () => {
    await load({ dark: true });
    theme.applyTheme();
    expect(theme.isDark()).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('светлая система → светлая тема, а явный выбор главнее системы', async () => {
    await load({ dark: false });
    expect(theme.isDark()).toBe(false);
    theme.update({ mode: 'dark' });
    expect(theme.isDark()).toBe(true);
  });
});

describe('синхронизация с сервером', () => {
  beforeEach(() => load());

  it('без токена на сервер не отправляет', () => {
    vi.useFakeTimers();
    theme.update({ bubble: 'soft' });
    vi.advanceTimersByTime(2000);
    expect(putAppearance).not.toHaveBeenCalled();
  });

  it('с токеном отправляет с задержкой и склеивает частые изменения в один запрос', () => {
    vi.useFakeTimers();
    token = 't';

    theme.update({ bubble: 'soft' });
    vi.advanceTimersByTime(500);
    theme.update({ bubble: 'square' });
    vi.advanceTimersByTime(799);
    expect(putAppearance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(putAppearance).toHaveBeenCalledTimes(1);
    expect(putAppearance.mock.calls[0][0]).toMatchObject({ bubble: 'square' });
  });

  it('loadRemoteAppearance: серверное оформление главнее локального', async () => {
    getAppearance.mockResolvedValue({ mode: 'dark', accent: 'indigo' });
    const listener = vi.fn();
    theme.subscribe(listener);

    await theme.loadRemoteAppearance();

    expect(theme.getAppearance()).toMatchObject({ mode: 'dark', accent: 'indigo' });
    expect(JSON.parse(localStorage.getItem('appearance')!).accent).toBe('indigo');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(listener).toHaveBeenCalled();
    expect(putAppearance).not.toHaveBeenCalled();
  });

  it('на сервере пусто, а локально есть изменения → отправляет локальное', async () => {
    theme.update({ bubble: 'square' });
    getAppearance.mockResolvedValue({});

    await theme.loadRemoteAppearance();

    expect(putAppearance).toHaveBeenCalledWith(expect.objectContaining({ bubble: 'square' }));
  });

  it('на сервере пусто и локально значения по умолчанию → ничего не отправляет', async () => {
    getAppearance.mockResolvedValue({});
    await theme.loadRemoteAppearance();
    expect(putAppearance).not.toHaveBeenCalled();
  });

  it('нет сети → остаётся локальное оформление', async () => {
    theme.update({ bubble: 'square' });
    getAppearance.mockRejectedValue(new Error('offline'));

    await expect(theme.loadRemoteAppearance()).resolves.toBeUndefined();

    expect(theme.getAppearance().bubble).toBe('square');
  });
});

describe('справочники', () => {
  beforeEach(() => load());

  it('id акцентов и пресетов уникальны, цвета акцентов в формате #rrggbb', () => {
    expect(new Set(theme.ACCENTS.map((a) => a.id)).size).toBe(theme.ACCENTS.length);
    expect(new Set(theme.PRESETS.map((p) => p.id)).size).toBe(theme.PRESETS.length);
    for (const a of theme.ACCENTS) for (const c of [...a.light, ...a.dark]) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('пресет по умолчанию существует', () => {
    expect(theme.PRESETS.some((p) => p.id === theme.DEFAULTS.wallpaper.id)).toBe(true);
  });

  it('presetCss выбирает вариант под тему', () => {
    const dawn = theme.PRESETS.find((p) => p.id === 'dawn')!;
    expect(theme.presetCss(dawn, false)).toBe(dawn.light);
    expect(theme.presetCss(dawn, true)).toBe(dawn.dark);
  });
});
