import { createPortal } from 'react-dom';
import { useEffect, useState, type ReactNode } from 'react';
import * as api from '../lib/api';
import { fmtLastSeen } from '../lib/format';
import type { Profile } from '../types';
import { Avatar } from './ui';

/** Модальное окно с произвольным содержимым: Esc и клик мимо закрывают; на телефоне выезжает снизу. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
        <div className="modal-actions"><button className="ghost" onClick={onClose}>Закрыть</button></div>
      </div>
    </div>,
    document.body,
  );
}

/** Профиль человека: о себе, статус, дата регистрации. action — главная кнопка (например, «Написать»). */
export function PeerProfile({ peer, online, action, onClose }: {
  peer: { id: string; login: string; displayName: string; avatarUrl?: string | null };
  online?: boolean; action?: { label: string; onClick: () => void }; onClose: () => void;
}) {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.profile(peer.id).then(setP).catch((e: Error) => setErr(e.message)); }, [peer.id]);
  const isOnline = online || p?.isOnline === true;
  const status = isOnline ? 'в сети' : p?.lastSeenAt ? fmtLastSeen(Date.parse(p.lastSeenAt)) : '';
  return (
    <Modal title="Профиль" onClose={onClose}>
      <div className="pcard">
        <Avatar name={peer.displayName} url={peer.avatarUrl} size={96} online={isOnline} />
        <div className="me-name">{p?.displayName ?? peer.displayName}</div>
        <div className="hint">@{peer.login}</div>
        {status && <span className={'chip ' + (isOnline ? 'on' : '')}>{status}</span>}
      </div>
      <div className="pbio">
        {err ? <span className="hint">{err}</span>
          : !p ? <span className="hint">Загружаем…</span>
          : p.bio ? p.bio : <span className="hint">Пока ничего не рассказал(а) о себе.</span>}
      </div>
      {p && <div className="hint pdate">В мессенджере с {new Date(p.createdAt).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })}</div>}
      {action && <button className="btn big wide" onClick={action.onClick}>{action.label}</button>}
    </Modal>
  );
}
