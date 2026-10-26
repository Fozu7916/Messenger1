import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { useChat } from '../lib/chat';
import { isHttpUrl } from '../lib/format';
import { beep, desktopSupported, enableDesktop, getNotifyPrefs, setNotifyPrefs } from '../lib/notify';
import { Avatar, Icon, useToast } from './ui';

type Section = 'profile' | 'notify' | 'sync' | 'session';
const SECTIONS: [Section, string][] = [['profile', 'Профиль'], ['notify', 'Уведомления'], ['sync', 'Синхронизация'], ['session', 'Сессия']];

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const { session } = useAuth();
  const [section, setSection] = useState<Section>('profile');
  const [open, setOpen] = useState(false);   // мобильная раскладка: раздел открыт поверх списка
  const u = session!.user;
  return (
    <div className={'main ' + (open ? 'open' : '')}>
      <aside className="side">
        <div className="side-head">
          <button className="icon-btn" onClick={onBack} aria-label="Назад к чатам" title="Назад к чатам"><Icon.Back /></button>
          <div className="title"><h1>Настройки</h1></div>
        </div>
        <div className="list">
          <button className="row" onClick={() => { setSection('profile'); setOpen(true); }} aria-current={section === 'profile'}>
            <Avatar name={u.displayName} url={u.avatarUrl} size={40} />
            <div className="t"><div className="n"><span>{u.displayName}</span></div><div className="m"><span>@{u.login}</span></div></div>
          </button>
          {SECTIONS.filter(([id]) => id !== 'profile').map(([id, label]) => (
            <button key={id} className="row" aria-current={section === id}
              onClick={() => { setSection(id); setOpen(true); }}>
              <div className="t"><div className="n"><span>{label}</span></div></div>
            </button>
          ))}
        </div>
      </aside>
      <section className="pane">
        <div className="pane-head">
          <button className="icon-btn back" onClick={() => setOpen(false)} aria-label="К разделам"><Icon.Back /></button>
          <div className="t"><div className="n">{SECTIONS.find(([id]) => id === section)![1]}</div></div>
        </div>
        <div className="panel">
          <div className="panel-inner">
            {section === 'profile' && <ProfileSection />}
            {section === 'notify' && <NotifySection />}
            {section === 'sync' && <SyncSection />}
            {section === 'session' && <SessionSection />}
          </div>
        </div>
      </section>
    </div>
  );
}

function ProfileSection() {
  const { session, updateProfile } = useAuth();
  const toast = useToast();
  const u = session!.user;
  const [name, setName] = useState(u.displayName);
  const [url, setUrl] = useState(u.avatarUrl ?? '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const nameOk = name.trim().length >= 1 && name.trim().length <= 60;
  const urlOk = !url.trim() || isHttpUrl(url.trim());
  const dirty = name.trim() !== u.displayName || url.trim() !== (u.avatarUrl ?? '');

  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await updateProfile({ displayName: name.trim(), avatarUrl: url.trim() || null }); toast('Профиль сохранён'); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={save} className="form">
      <div><h2>Профиль</h2><p className="lead">Так вас видят собеседники.</p></div>
      <div className="me-card">
        <Avatar name={name || u.login} url={urlOk ? url.trim() : ''} size={64} />
        <div><div className="me-name">{name.trim() || '—'}</div><div className="hint">@{u.login}</div></div>
      </div>
      <div className="form">
        <label className="lbl">Имя<input className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
        {!nameOk && <div className="err">Введите имя — от 1 до 60 символов.</div>}
        <label className="lbl">Ссылка на аватар<input className="field" value={url} placeholder="https://…" inputMode="url" onChange={(e) => setUrl(e.target.value)} /></label>
        {!urlOk && <div className="err">Нужна публичная ссылка, начинающаяся с https://.</div>}
        <label className="lbl">Логин<input className="field" value={u.login} disabled title="Логин изменить нельзя" /></label>
        <div className="err" role="alert">{err}</div>
        <div className="actions">
          <button type="button" className="ghost" disabled={!dirty || busy} onClick={() => { setName(u.displayName); setUrl(u.avatarUrl ?? ''); setErr(''); }}>Сбросить</button>
          <button className="btn" disabled={!dirty || !nameOk || !urlOk || busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
        </div>
      </div>
    </form>
  );
}

function NotifySection() {
  const toast = useToast();
  const [prefs, setPrefs] = useState(getNotifyPrefs);
  const update = (p: typeof prefs) => { setPrefs(p); setNotifyPrefs(p); };
  const denied = desktopSupported() && Notification.permission === 'denied';

  return (
    <>
      <div><h2>Уведомления</h2><p className="lead">Работают, пока вкладка с мессенджером открыта. Число непрочитанных видно в заголовке вкладки.</p></div>
      <div className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
      <label className="check">
        <input type="checkbox" checked={prefs.sound} onChange={(e) => { update({ ...prefs, sound: e.target.checked }); if (e.target.checked) beep(); }} />
        <span>Звук при новом сообщении</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.desktop} disabled={!desktopSupported() || denied}
          onChange={async (e) => {
            if (!e.target.checked) { update({ ...prefs, desktop: false }); return; }
            if (await enableDesktop()) update({ ...prefs, desktop: true });
            else toast('Браузер не разрешил уведомления');
          }} />
        <span>Системные уведомления, когда вкладка в фоне
          {!desktopSupported() && <small>Браузер не поддерживает уведомления</small>}
          {denied && <small>Запрещено в настройках браузера для этого сайта</small>}
        </span>
      </label>
      </div>
    </>
  );
}

function SyncSection() {
  const { db, status, error, resync, resetLocal } = useChat();
  const toast = useToast();
  const [counts, setCounts] = useState<[number, number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const count = () => db && Promise.all([db.dialogs.find().exec(), db.messages.find().exec(), db.messages.find({ selector: { status: 'pending' } }).exec()]).then((r) => setCounts([r[0].length, r[1].length, r[2].length]));
  useEffect(() => { void count(); }, [db, status]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await fn(); await count(); toast(ok); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const label = { online: 'Подключено', connecting: 'Подключаемся…', offline: 'Нет соединения' }[status];

  return (
    <>
      <div><h2>Синхронизация</h2><p className="lead">Переписка хранится на устройстве: работает без сети, сообщения уходят, когда соединение вернётся.</p></div>
      <div className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
      <div className="kv"><span>Соединение</span><b className={'dot ' + status}>{label}</b></div>
      <div className="kv"><span>Диалогов на устройстве</span><b>{counts?.[0] ?? '—'}</b></div>
      <div className="kv"><span>Сообщений на устройстве</span><b>{counts?.[1] ?? '—'}</b></div>
      <div className="kv"><span>Ждут отправки</span><b>{counts?.[2] ?? '—'}</b></div>
      {error && <div className="kv"><span>Последняя ошибка</span><b>{error}</b></div>}
      </div>
      <div className="actions left">
        <button className="btn" disabled={busy || status !== 'online'} onClick={() => run(resync, 'Синхронизировано')}>Синхронизировать сейчас</button>
        <button className={'ghost' + (confirm ? ' danger' : '')} disabled={busy || status !== 'online'}
          onClick={() => { if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; } setConfirm(false); void run(resetLocal, 'Кэш очищен и загружен заново'); }}>
          {confirm ? 'Точно очистить?' : 'Очистить локальный кэш'}
        </button>
      </div>
      <p className="hint">Очистка удалит копию переписки с этого устройства и загрузит её с сервера заново. Неотправленные сообщения будут потеряны.</p>
    </>
  );
}

function SessionSection() {
  const { session, logout } = useAuth();
  const until = new Date(session!.expiresAt).toLocaleString('ru', { dateStyle: 'long', timeStyle: 'short' });
  return (
    <>
      <div><h2>Сессия</h2><p className="lead">Пока вкладка открыта, сессия продлевается автоматически. При выходе локальная копия переписки удаляется с устройства.</p></div>
      <div className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
        <div className="kv"><span>Аккаунт</span><b>@{session!.user.login}</b></div>
        <div className="kv"><span>Токен действует до</span><b>{until}</b></div>
      </div>
      <div className="actions left"><button className="ghost danger" onClick={logout}>Выйти из аккаунта</button></div>
    </>
  );
}