// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Notify = typeof import('./notify');
let notify: Notify;

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static created: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(public title: string, public options?: NotificationOptions) { FakeNotification.created.push(this); }
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  FakeNotification.permission = 'default';
  FakeNotification.created = [];
  FakeNotification.requestPermission.mockClear();
  notify = await import('./notify');
});
afterEach(() => vi.unstubAllGlobals());

describe('настройки уведомлений', () => {
  it('по умолчанию звук включён, системные уведомления выключены', () => {
    expect(notify.getNotifyPrefs()).toEqual({ sound: true, desktop: false });
  });

  it('частично сохранённые настройки дополняются значениями по умолчанию', () => {
    localStorage.setItem('pref:notify', JSON.stringify({ desktop: true }));
    expect(notify.getNotifyPrefs()).toEqual({ sound: true, desktop: true });
  });

  it('повреждённое значение → значения по умолчанию', () => {
    localStorage.setItem('pref:notify', '{oops');
    expect(notify.getNotifyPrefs()).toEqual({ sound: true, desktop: false });
  });

  it('setNotifyPrefs сохраняет и переживает очистку ui-состояния', async () => {
    notify.setNotifyPrefs({ sound: false, desktop: true });
    const { clearUiState } = await import('./persist');
    clearUiState();   // выход из аккаунта
    expect(notify.getNotifyPrefs()).toEqual({ sound: false, desktop: true });
  });
});

describe('системные уведомления', () => {
  it('без поддержки браузера: desktopSupported=false, enableDesktop=false, showDesktop молчит', async () => {
    expect(notify.desktopSupported()).toBe(false);
    expect(await notify.enableDesktop()).toBe(false);
    expect(() => notify.showDesktop('a', 'b', 't')).not.toThrow();
  });

  it('enableDesktop спрашивает разрешение один раз и возвращает результат', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.requestPermission.mockResolvedValueOnce('granted');
    expect(await notify.enableDesktop()).toBe(true);
    FakeNotification.requestPermission.mockResolvedValueOnce('denied');
    FakeNotification.permission = 'default';
    expect(await notify.enableDesktop()).toBe(false);
  });

  it('если разрешение уже выдано, повторно не спрашивает', async () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    expect(await notify.enableDesktop()).toBe(true);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('showDesktop без разрешения ничего не показывает', () => {
    vi.stubGlobal('Notification', FakeNotification);
    notify.showDesktop('Боб', 'привет', 'D1');
    expect(FakeNotification.created).toHaveLength(0);
  });

  it('showDesktop с разрешением: заголовок, текст, tag; клик фокусирует окно и закрывает уведомление', () => {
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});

    notify.showDesktop('Боб', 'привет', 'D1');

    const n = FakeNotification.created[0];
    expect([n.title, n.options?.body, n.options?.tag]).toEqual(['Боб', 'привет', 'D1']);
    n.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(n.close).toHaveBeenCalled();
  });
});

describe('звук', () => {
  it('без AudioContext beep молча ничего не делает', () => {
    expect(() => notify.beep()).not.toThrow();
  });

  it('с AudioContext запускает и останавливает осциллятор; приостановленный контекст возобновляет', () => {
    const osc = { type: '', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const param = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
    const resume = vi.fn();
    class FakeAudio {
      state = 'suspended'; currentTime = 1; destination = {};
      resume = resume;
      createOscillator = () => osc;
      createGain = () => ({ gain: param, connect: vi.fn() });
    }
    vi.stubGlobal('AudioContext', FakeAudio);

    notify.beep();

    expect(resume).toHaveBeenCalled();
    expect(osc.start).toHaveBeenCalledWith(1);
    expect(osc.stop).toHaveBeenCalledWith(1.26);
    expect(osc.frequency.value).toBe(880);
  });
});
