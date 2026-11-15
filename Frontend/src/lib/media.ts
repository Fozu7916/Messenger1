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

// ---- Видео ----
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_MS = 180_000;

export interface VideoMeta { width: number; height: number; durationMs: number; poster: Blob | null }

/**
 * Читает размеры и длительность видео и снимает кадр-превью. Если не удался только кадр, возвращает poster = null
 * (превью необязательно). Если браузер не понимает само видео — бросает ошибку с причиной (чаще всего кодек HEVC/H.265).
 */
export function captureVideoMeta(file: Blob): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'auto'; v.muted = true; v.playsInline = true;
    let done = false;
    let seekTimer: number | undefined;
    const cleanup = () => {
      clearTimeout(overall); clearTimeout(seekTimer);
      v.onerror = null; v.onloadedmetadata = null; v.onseeked = null;
      v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url);
    };
    const ok = (meta: VideoMeta) => { if (done) return; done = true; cleanup(); resolve(meta); };
    const fail = (msg: string) => { if (done) return; done = true; cleanup(); reject(new Error(msg)); };
    const overall = window.setTimeout(() => fail('Не удалось прочитать видео за разумное время. Попробуйте файл поменьше или другой формат.'), 20000);
    const info = () => ({ width: v.videoWidth, height: v.videoHeight, durationMs: Math.round(v.duration * 1000) });
    const snapshot = () => {
      try {
        const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(v.videoWidth * scale)); canvas.height = Math.max(1, Math.round(v.videoHeight * scale));
        canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((poster) => ok({ ...info(), poster }), 'image/jpeg', 0.75);
      } catch { ok({ ...info(), poster: null }); }
    };
    v.onerror = () => fail(v.error?.code === 4
      ? 'Браузер не поддерживает кодек этого видео (часто это HEVC/H.265). Перекодируйте в H.264 (MP4) или WebM.'
      : 'Браузер не смог прочитать это видео.');
    v.onloadedmetadata = () => {
      if (!v.videoWidth || !v.videoHeight) { fail('Браузер не распознал видеодорожку: скорее всего, кодек HEVC/H.265 или AV1. Перекодируйте в H.264 (MP4) или WebM.'); return; }
      if (!Number.isFinite(v.duration) || v.duration <= 0) { fail('В файле не указана длительность. Сохраните видео в MP4 (H.264) или WebM.'); return; }
      seekTimer = window.setTimeout(() => ok({ ...info(), poster: null }), 3000);   // перемотка не сработала — отправим без превью
      v.currentTime = Math.min(1, v.duration / 2);   // кадр не из самого начала: там часто чёрный экран
    };
    v.onseeked = () => { clearTimeout(seekTimer); snapshot(); };
    v.src = url;
  });
}

/** Загрузка файла прямо в хранилище по временной ссылке (без токена API; бакету нужен CORS на PUT). */
export async function uploadToStorage(url: string, blob: Blob, contentType: string) {
  let res: Response;
  try { res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob }); }
  catch { throw new api.ApiError(0, 'Не удалось загрузить видео: нет соединения или хранилище не разрешает загрузку с этого сайта (CORS)'); }
  if (!res.ok) throw new api.ApiError(res.status, `Хранилище отклонило загрузку (${res.status})`);
}

const links = new Map<string, { url: string; until: number }>();
/** Временная ссылка на просмотр видео (живёт час; кэшируем на 50 минут). */
export async function getVideoLink(mediaPath: string): Promise<string> {
  const hit = links.get(mediaPath);
  if (hit && hit.until > Date.now()) return hit.url;
  const m = /^\/api\/dialogs\/([0-9A-Za-z]{26})\/media\/(.+)$/.exec(mediaPath);
  if (!m) throw new Error('bad media path');
  const { url } = await api.mediaLink(m[1], m[2]);
  links.set(mediaPath, { url, until: Date.now() + 50 * 60_000 });
  return url;
}
