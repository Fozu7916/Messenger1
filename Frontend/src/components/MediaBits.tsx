import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { getVideoLink, useMediaUrl } from '../lib/media';
import type { MessageDoc } from '../types';

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** Фото в пузыре: до загрузки — заглушка нужных пропорций (ничего не «прыгает»), клик открывает на весь экран. */
export function ImageBubble({ m, onOpen }: { m: MessageDoc; onOpen: (url: string) => void }) {
  const url = useMediaUrl(m.media);
  const ratio = m.mw && m.mh ? m.mw / m.mh : 4 / 3;
  const width = Math.min(320, Math.round(360 * ratio));
  return (
    <button type="button" className={'imgb' + (m.status === 'pending' ? ' pend' : '')} style={{ width, aspectRatio: String(ratio) }}
      disabled={!url} onClick={() => url && onOpen(url)} aria-label="Открыть фото">
      {url && <img src={url} alt="" draggable={false} />}
    </button>
  );
}

/** Видео в пузыре: кадр-превью и кнопка «играть»; по клику берём временную ссылку и играем прямо из хранилища (перемотка работает). */
export function VideoBubble({ m }: { m: MessageDoc }) {
  const local = m.media.startsWith('blob:');   // ещё не отправлено: играем локальный файл
  const posterUrl = useMediaUrl(local ? '' : m.media.replace(/\.(mp4|webm)$/, '.webp'));
  const [src, setSrc] = useState<string | null>(local ? m.media : null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setSrc(local ? m.media : null); }, [m.media]);
  const ratio = m.mw && m.mh ? m.mw / m.mh : 16 / 9;
  const width = Math.min(360, Math.round(360 * ratio));
  const play = () => {
    setLoading(true); setFailed(false);
    getVideoLink(m.media).then(setSrc).catch(() => setFailed(true)).finally(() => setLoading(false));
  };
  return (
    <div className={'vidb' + (m.status === 'pending' ? ' pend' : '')} style={{ width, aspectRatio: String(ratio) }}>
      {src
        ? <video src={src} controls autoPlay={!local} playsInline preload="metadata" poster={posterUrl ?? undefined} onError={() => { if (!local) { setSrc(null); setFailed(true); } }} />
        : (
          <button type="button" className="vidplay" onClick={play} disabled={loading} aria-label="Смотреть видео">
            {posterUrl && <img src={posterUrl} alt="" draggable={false} />}
            <span className="pbtn">{loading ? '…' : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>}</span>
            {m.dur > 0 && <span className="vdur">{mmss(m.dur / 1000)}</span>}
          </button>
        )}
      {failed && <div className="vfail">Не удалось загрузить видео</div>}
    </div>
  );
}

let playing: HTMLAudioElement | null = null;   // одновременно звучит только одно голосовое

export function VoicePlayer({ m }: { m: MessageDoc }) {
  const url = useMediaUrl(m.media);
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [pos, setPos] = useState(0);
  const total = Math.max(1, m.dur / 1000);   // у записей MediaRecorder длительность в самом файле не указана, берём сохранённую
  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) { if (playing && playing !== a) playing.pause(); playing = a; void a.play(); } else a.pause();
  };
  return (
    <div className="voice">
      <button type="button" className="vplay" onClick={toggle} disabled={!url} aria-label={on ? 'Пауза' : 'Воспроизвести'}>
        {on
          ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>
          : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" /></svg>}
      </button>
      <input className="range vbar" type="range" min={0} max={total} step={0.05} value={Math.min(pos, total)} disabled={!url} aria-label="Перемотка"
        onChange={(e) => { const a = audio.current; if (a) { a.currentTime = Number(e.target.value); setPos(a.currentTime); } }} />
      <span className="vtime">{mmss(on || pos > 0 ? pos : total)}</span>
      <audio ref={audio} src={url ?? undefined} preload="metadata"
        onPlay={() => setOn(true)} onPause={() => setOn(false)}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onEnded={() => { setOn(false); setPos(0); }} />
    </div>
  );
}

/** Просмотр фото на весь экран: Esc или клик закрывают. */
export function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Фото" onClick={onClose}>
      <img src={url} alt="" />
      <button type="button" className="icbtn" aria-label="Закрыть" onClick={onClose}>✕</button>
    </div>,
    document.body,
  );
}

export const fmtDuration = mmss;
