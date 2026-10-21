// Уведомления работают только пока вкладка открыта (без push): звук, системное окно для фоновой вкладки.
export interface NotifyPrefs { sound: boolean; desktop: boolean }

// Ключ не начинается с «ui:», чтобы настройка переживала выход из аккаунта (см. clearUiState).
const KEY = 'pref:notify';

export const getNotifyPrefs = (): NotifyPrefs => {
  try { return { sound: true, desktop: false, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { sound: true, desktop: false }; }
};
export const setNotifyPrefs = (p: NotifyPrefs) => {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
};

export const desktopSupported = () => typeof Notification !== 'undefined';

/** Спрашивает разрешение браузера; true — системные уведомления можно показывать. */
export async function enableDesktop(): Promise<boolean> {
  if (!desktopSupported()) return false;
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  return p === 'granted';
}

let audio: AudioContext | null = null;
/** Короткий звуковой сигнал; браузер может заблокировать его до первого действия пользователя — тогда молчим. */
export function beep() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
    const t = audio.currentTime;
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = 'sine'; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain); gain.connect(audio.destination);
    osc.start(t); osc.stop(t + 0.26);
  } catch { /* ignore */ }
}

/** Системное уведомление — только для открытой, но неактивной вкладки. */
export function showDesktop(title: string, body: string, tag: string) {
  if (!desktopSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* ignore */ }
}
