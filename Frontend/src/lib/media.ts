// Вложения сообщений: фото и голосовые приватны, поэтому берём их через fetch с токеном, кэшируем в Cache Storage
// (работает офлайн) и показываем blob-ссылкой. Плюс запись голосовых через MediaRecorder.
import { useEffect, useRef, useState } from 'react';
import * as api from './api';

const urls = new Map<string, Promise<string>>();   // путь вложения → blob-ссылка (одна загрузка на файл за сеанс)
async function load(path: string): Promise<string> {
  let blob: Blob | undefined;
  try { const hit = await (await caches.open('media')).match(path); if (hit) blob = await hit.blob(); } catch { /* Cache Storage недоступен */ }
  if (!blob) {
    blob = await api.authedBlob(path);
    try { await (await caches.open('media')).put(path, new Response(blob)); } catch { /* не критично */ }
  }
  return URL.createObjectURL(blob);
}

/** Ссылка на вложение для <img>/<audio>; null, пока грузится или не удалось. Локальные blob: (ещё не отправленные) отдаются как есть. */
export function useMediaUrl(src: string): string | null {
  const local = !src || src.startsWith('blob:');
  const [url, setUrl] = useState<string | null>(local ? src || null : null);
  useEffect(() => {
    if (local) { setUrl(src || null); return; }
    let alive = true;
    let p = urls.get(src);
    if (!p) { p = load(src); urls.set(src, p); p.catch(() => urls.delete(src)); }
    p.then((u) => { if (alive) setUrl(u); }).catch(() => { if (alive) setUrl(null); });
    return () => { alive = false; };
  }, [src]);
  return url;
}

const MIMES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
export const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

export function useVoiceRecorder() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number>();
  const started = useRef(0);
  const cleanup = () => {
    clearInterval(timer.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null; rec.current = null;
    setRecording(false); setSeconds(0);
  };
  useEffect(() => () => cancel(), []);   // ушли со страницы — микрофон выключаем
  const start = async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });   // бросит ошибку, если доступ запрещён
    const mime = MIMES.find((t) => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
    stream.current = s; rec.current = r; chunks.current = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    r.start(250);
    started.current = Date.now();
    setRecording(true);
    timer.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 250);
  };
  /** Остановить и получить запись (null — пусто). */
  const finish = () => new Promise<{ blob: Blob; durationMs: number } | null>((resolve) => {
    const r = rec.current;
    if (!r) { resolve(null); return; }
    const durationMs = Date.now() - started.current;
    r.onstop = () => {
      const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
      cleanup();
      resolve(blob.size && durationMs > 400 ? { blob, durationMs } : null);
    };
    r.stop();
  });
  const cancel = () => {
    const r = rec.current;
    if (r && r.state !== 'inactive') { r.onstop = null; r.stop(); }
    cleanup();
  };
  return { recording, seconds, start, finish, cancel };
}
