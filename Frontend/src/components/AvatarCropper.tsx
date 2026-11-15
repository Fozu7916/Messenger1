import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const V = 280;      // сторона области просмотра, px
const OUT = 512;    // сторона итоговой картинки, px
const MAX_ZOOM = 4;

/** Редактор кадра, как в Telegram: картинку двигают пальцем/мышью и масштабируют ползунком или колесом, в итоге — квадрат 512×512. */
export function AvatarCropper({ file, onDone, onClose }: { file: File; onDone: (cropped: File) => void; onClose: () => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });   // смещение центра картинки от центра области
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => setFailed(true);
    i.src = url;
    return () => URL.revokeObjectURL(url);
  }, [url]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const base = img ? V / Math.min(img.naturalWidth, img.naturalHeight) : 1;   // картинка покрывает область при zoom = 1
  const scale = base * zoom;
  const clamp = (o: { x: number; y: number }, s = scale) => {
    if (!img) return o;
    const mx = Math.max(0, (img.naturalWidth * s - V) / 2), my = Math.max(0, (img.naturalHeight * s - V) / 2);
    return { x: Math.min(mx, Math.max(-mx, o.x)), y: Math.min(my, Math.max(-my, o.y)) };
  };
  const setZ = (z: number) => {
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    setZoom(nz); setOff((o) => clamp(o, base * nz));
  };

  const save = () => {
    if (!img) return;
    const size = V / scale;   // сторона вырезаемого квадрата в пикселях исходника
    const sx = img.naturalWidth / 2 - off.x / scale - size / 2;
    const sy = img.naturalHeight / 2 - off.y / scale - size / 2;
    const c = document.createElement('canvas');
    c.width = c.height = OUT;
    c.getContext('2d')!.drawImage(img, sx, sy, size, size, 0, 0, OUT, OUT);
    c.toBlob((b) => {
      if (b) onDone(new File([b], 'avatar.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  };

  return createPortal(
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Кадрирование фото">
        <h3>Кадрирование</h3>
        {failed ? <p>Не удалось прочитать изображение.</p> : (
          <>
            <div className="crop" style={{ width: V, height: V }}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }; }}
              onPointerMove={(e) => { const d = drag.current; if (d) setOff(clamp({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y })); }}
              onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
              onWheel={(e) => setZ(zoom - e.deltaY / 500)}>
              {img && <img src={url} alt="" draggable={false} style={{
                width: img.naturalWidth * scale, height: img.naturalHeight * scale,
                transform: `translate(calc(-50% + ${off.x}px), calc(-50% + ${off.y}px))`,
              }} />}
              <i className="crop-ring" aria-hidden="true" />
            </div>
            <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={zoom} aria-label="Масштаб" onChange={(e) => setZ(Number(e.target.value))} style={{ width: V }} />
          </>
        )}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>Отмена</button>
          {!failed && <button disabled={!img} onClick={save}>Готово</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
