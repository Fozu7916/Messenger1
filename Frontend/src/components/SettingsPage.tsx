import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import * as api from '../lib/api';
import { useAuth } from '../lib/auth';
import { useChat } from '../lib/chat';
import { beep, desktopSupported, enableDesktop, getNotifyPrefs, setNotifyPrefs } from '../lib/notify';
import { ACCENTS, PRESETS, presetCss, reset as resetAppearance, update as setAppearance, useAppearance, useWallpaperUrl, type Bubble, type Density, type FontFamily, type ThemeMode } from '../lib/theme';
import type { Profile } from '../types';
import { Avatar, useToast } from './ui';

type Section = 'profile' | 'security' | 'appearance' | 'notify' | 'device';
const GROUPS: { title: string; items: [Section, string, string][] }[] = [
  { title: 'Аккаунт', items: [['profile', 'Профиль', 'Имя, фото, о себе'], ['security', 'Безопасность', 'Пароль и сессии']] },
  { title: 'Приложение', items: [['appearance', 'Внешний вид', 'Тема и акцентный цвет'], ['notify', 'Уведомления', 'Звук и системные']] },
  { title: 'Устройство', items: [['device', 'Сессия и данные', 'Выход, локальный кэш']] },
];

export function SettingsPage() {
  const [section, setSection] = useState<Section>('profile');
  return (
    <div className="settings">
      <aside className="side settings-nav">
        <h3>Настройки</h3>
        <div role="tablist" className="snav">
          {GROUPS.map((g) => (
            <div key={g.title} className="sgroup-nav">
              <div className="sect">{g.title}</div>
              {g.items.map(([id, label, hint]) => (
                <button key={id} role="tab" className="row" aria-selected={section === id} aria-current={section === id} onClick={() => setSection(id)}>
                  <div className="t"><div className="n">{label}</div><div className="m"><span>{hint}</span></div></div>
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <section className="panel" key={section}>
        {section === 'profile' && <ProfileSection />}
        {section === 'security' && <SecuritySection />}
        {section === 'appearance' && <AppearanceSection />}
        {section === 'notify' && <NotifySection />}
        {section === 'device' && <DeviceSection />}
      </section>
    </div>
  );
}

/** Заголовок раздела и карточка-группа настроек (строки внутри разделены линиями). */
const Head = ({ title, sub }: { title: string; sub?: string }) => <><h2 className="ptitle">{title}</h2>{sub && <p className="sub">{sub}</p>}</>;
const Group = ({ title, children, hint }: { title?: string; children: ReactNode; hint?: string }) => (
  <div className="sblock">
    {title && <div className="stitle">{title}</div>}
    <div className="sgroup">{children}</div>
    {hint && <p className="hint shint">{hint}</p>}
  </div>
);

/** Понятное сообщение об ошибке загрузки файла (сервер отвечает коротким английским title, а пользователю нужен русский). */
function uploadError(e: unknown): string {
  if (e instanceof api.ApiError) {
    if (e.status === 400) return 'Не удалось прочитать файл. Нужна картинка JPEG, PNG, WebP или GIF до 5 МБ.';
    if (e.status === 409) return 'Можно загрузить не больше 12 обоев — удалите ненужные.';
    if (e.status === 413) return 'Файл больше 5 МБ.';
    if (e.status === 503) return 'Хранилище файлов сейчас недоступно, попробуйте позже.';
  }
  return (e as Error).message;
}

function ProfileSection() {
  const { session, updateProfile, applyProfile } = useAuth();
  const toast = useToast();
  const u = session!.user;
  const [name, setName] = useState(u.displayName);
  const [bio, setBio] = useState('');
  const [saved, setSaved] = useState<Profile | null>(null);   // профиль с сервера: пока не загружен, «О себе» не трогаем
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { api.me().then((p) => { setSaved(p); setBio(p.bio ?? ''); }).catch(() => {}); }, []);
  const nameOk = name.trim().length >= 1 && name.trim().length <= 60;
  const dirty = name.trim() !== u.displayName || (!!saved && bio.trim() !== (saved.bio ?? ''));
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const p = await updateProfile({ displayName: name.trim(), avatarUrl: u.avatarUrl, bio: saved ? bio.trim() : undefined });
      setSaved(p); setBio(p.bio ?? ''); toast('Профиль сохранён');
    } catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };
  const pick = async (f?: File) => {
    if (file.current) file.current.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('Файл больше 5 МБ'); return; }
    setPhotoBusy(true);
    try { applyProfile(await api.uploadAvatar(f)); toast('Фото обновлено'); } catch (x) { toast(uploadError(x)); } finally { setPhotoBusy(false); }
  };
  const removePhoto = async () => {
    setPhotoBusy(true);
    try { applyProfile(await api.deleteAvatar()); toast('Фото удалено'); } catch (x) { toast(uploadError(x)); } finally { setPhotoBusy(false); }
  };
  return (
    <form onSubmit={save}>
      <Head title="Профиль" sub="Так вас видят собеседники." />
      <div className="me-card">
        <Avatar name={name || u.login} url={u.avatarUrl} size={96} />
        <div>
          <div className="me-name">{name.trim() || '—'}</div>
          <div className="hint">@{u.login}{saved && ` · с ${new Date(saved.createdAt).toLocaleDateString('ru', { month: 'long', year: 'numeric' })}`}</div>
          <div className="actions left avedit">
            <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => void pick(e.target.files?.[0])} />
            <button type="button" className="ghost" disabled={photoBusy} onClick={() => file.current?.click()}>{photoBusy ? 'Загружаем…' : u.avatarUrl ? 'Сменить фото' : 'Загрузить фото'}</button>
            {u.avatarUrl && <button type="button" className="ghost" disabled={photoBusy} onClick={() => void removePhoto()}>Удалить</button>}
          </div>
        </div>
      </div>
      <Group title="Основное">
        <label className="srow col">Имя<input className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          {!nameOk && <span className="err">Введите имя — от 1 до 60 символов.</span>}</label>
        <label className="srow col">О себе
          <textarea className="field area" value={bio} maxLength={300} disabled={!saved} placeholder={saved ? 'Пару слов о себе' : 'Загружаем…'} onChange={(e) => setBio(e.target.value)} />
          <span className="hint">{bio.length} / 300</span></label>
      </Group>
      <Group title="Логин" hint="Логин изменить нельзя.">
        <label className="srow col"><input className="field" value={u.login} disabled aria-label="Логин" /></label>
      </Group>
      <div className="err" role="alert">{err}</div>
      <div className="actions">
        <button type="button" className="ghost" disabled={!dirty || busy} onClick={() => { setName(u.displayName); setBio(saved?.bio ?? ''); setErr(''); }}>Сбросить</button>
        <button className="btn" disabled={!dirty || !nameOk || busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
      </div>
    </form>
  );
}

function SecuritySection() {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const bytes = new TextEncoder().encode(next).length;   // BCrypt учитывает только первые 72 байта — сервер отвергает длиннее
  const nextOk = next.length >= 8 && bytes <= 72;
  const ok = !!cur && nextOk && next === again && next !== cur;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      await api.changePassword(cur, next);
      setCur(''); setNext(''); setAgain('');
      toast('Пароль изменён. На других устройствах потребуется войти заново');
    } catch (x) {
      const code = x instanceof api.ApiError ? x.status : 0;
      setErr(code === 400 ? 'Неверный текущий пароль или новый совпадает со старым.' : (x as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit}>
      <Head title="Безопасность" sub="Смена пароля завершит сессии на всех остальных устройствах; на этом вход сохранится." />
      <Group title="Смена пароля" hint="От 8 символов, не длиннее 72 байт.">
        <label className="srow col">Текущий пароль<input className="field" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
        <label className="srow col">Новый пароль<input className="field" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          {next && !nextOk && <span className="err">Слишком короткий или длинный пароль.</span>}</label>
        <label className="srow col">Ещё раз<input className="field" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          {again && again !== next && <span className="err">Пароли не совпадают.</span>}</label>
      </Group>
      <div className="err" role="alert">{err}</div>
      <div className="actions"><button className="btn" disabled={!ok || busy}>{busy ? 'Меняем…' : 'Сменить пароль'}</button></div>
    </form>
  );
}

const MODES: [ThemeMode, string][] = [['auto', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']];
const BUBBLES: [Bubble, string][] = [['round', 'Круглые'], ['soft', 'Мягкие'], ['square', 'Строгие']];
const DENSITIES: [Density, string][] = [['compact', 'Компактно'], ['normal', 'Обычно'], ['cozy', 'Свободно']];
const FONT_OPTIONS: [FontFamily, string][] = [['sans', 'Без засечек'], ['serif', 'С засечками'], ['mono', 'Моноширинный']];

/** Плитка загруженных обоев: превью приходит с сервера по токену. */
function UploadedTile({ id, selected, onPick, onDelete }: { id: string; selected: boolean; onPick: () => void; onDelete: () => void }) {
  const url = useWallpaperUrl(id);
  return (
    <div className="wp-wrap">
      <button type="button" role="radio" aria-checked={selected} className="wp" aria-label="Свои обои" onClick={onPick}
        style={url ? { background: `url("${url}") center/cover` } : undefined} />
      <button type="button" className="del" aria-label="Удалить обои" title="Удалить" onClick={onDelete}>✕</button>
    </div>
  );
}

function AppearanceSection() {
  const a = useAppearance();
  const toast = useToast();
  const [uploads, setUploads] = useState<api.Wallpaper[] | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { api.wallpapers().then(setUploads).catch(() => setUploads([])); }, []);
  const upload = async (f?: File) => {
    if (file.current) file.current.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('Файл больше 5 МБ'); return; }
    setBusy(true);
    try {
      const w = await api.uploadWallpaper(f);
      setUploads((l) => [w, ...(l ?? [])]);
      setAppearance({ wallpaper: { kind: 'upload', id: w.id, dim: 0.15 } });
    } catch (x) { toast(uploadError(x)); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    try {
      await api.deleteWallpaper(id);
      setUploads((l) => (l ?? []).filter((w) => w.id !== id));
      if (a.wallpaper.kind === 'upload' && a.wallpaper.id === id) setAppearance({ wallpaper: { kind: 'preset', id: 'dots', dim: 0 } });
    } catch (x) { toast(uploadError(x)); }
  };
  const customAccent = a.accent.startsWith('#');
  return (
    <div>
      <Head title="Внешний вид" sub="Выбор сохраняется в вашем аккаунте и подтягивается на любом устройстве." />
      <div className="wp-preview" aria-hidden="true">
        <div className="msg in">Привет! Как тебе новое оформление?<span className="meta">14:20</span></div>
        <div className="msg out">Выглядит классно<span className="meta">14:21</span></div>
      </div>
      <Group title="Тема">
        <div className="choices" role="radiogroup" aria-label="Тема">
          {MODES.map(([id, label]) => (
            <button key={id} role="radio" aria-checked={a.mode === id} className={'choice theme-' + id} onClick={() => setAppearance({ mode: id })}>
              <span className="swatch" aria-hidden="true"><i /><i /></span>{label}
            </button>
          ))}
        </div>
      </Group>
      <Group title="Акцентный цвет" hint="Цвет кнопок, ссылок, непрочитанных и ваших сообщений. Свой цвет подберите последним кружком.">
        <div className="accents" role="radiogroup" aria-label="Акцентный цвет">
          {ACCENTS.map((x) => (
            <button key={x.id} role="radio" aria-checked={a.accent === x.id} className="accent" title={x.name} aria-label={x.name}
              style={{ ['--c' as string]: x.light[0] }} onClick={() => setAppearance({ accent: x.id })} />
          ))}
          <label className={'accent custom' + (customAccent ? ' on' : '')} title="Свой цвет" style={customAccent ? { ['--c' as string]: a.accent } : undefined}>
            <input type="color" aria-label="Свой цвет" value={customAccent ? a.accent : '#cc3d18'} onChange={(e) => setAppearance({ accent: e.target.value })} />
          </label>
        </div>
      </Group>
      <Group title="Обои чата" hint="Загруженная картинка уменьшается до 1920 px и хранится в облаке; можно загрузить до 12 штук.">
        <div className="wps" role="radiogroup" aria-label="Обои чата">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={a.wallpaper.kind === 'preset' && a.wallpaper.id === p.id} className="wp" title={p.name} aria-label={p.name}
              style={{ background: presetCss(p) }} onClick={() => setAppearance({ wallpaper: { kind: 'preset', id: p.id, dim: 0 } })} />
          ))}
          {uploads?.map((w) => (
            <UploadedTile key={w.id} id={w.id} selected={a.wallpaper.kind === 'upload' && a.wallpaper.id === w.id}
              onPick={() => setAppearance({ wallpaper: { kind: 'upload', id: w.id, dim: a.wallpaper.kind === 'upload' ? a.wallpaper.dim : 0.15 } })} onDelete={() => void remove(w.id)} />
          ))}
          <button type="button" className="wp add" disabled={busy} onClick={() => file.current?.click()}>{busy ? '…' : '+ Своё фото'}</button>
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => void upload(e.target.files?.[0])} />
        </div>
        {a.wallpaper.kind === 'upload' && (
          <label className="srow col">Затемнение: {Math.round(a.wallpaper.dim * 100)}%
            <input className="range" type="range" min={0} max={60} value={Math.round(a.wallpaper.dim * 100)}
              onChange={(e) => setAppearance({ wallpaper: { ...a.wallpaper, dim: Number(e.target.value) / 100 } })} />
          </label>
        )}
      </Group>
      <Group title="Сообщения">
        <div className="srow col">Форма пузырей
          <div className="choices flush" role="radiogroup" aria-label="Форма пузырей">
            {BUBBLES.map(([id, label]) => (
              <button key={id} role="radio" aria-checked={a.bubble === id} className={'choice b-' + id} onClick={() => setAppearance({ bubble: id })}>
                <span className="bsw" aria-hidden="true"><i /></span>{label}
              </button>
            ))}
          </div>
        </div>
        <div className="srow col">Плотность
          <div className="seg" role="radiogroup" aria-label="Плотность">
            {DENSITIES.map(([id, label]) => <button key={id} role="radio" aria-selected={a.density === id} aria-checked={a.density === id} onClick={() => setAppearance({ density: id })}>{label}</button>)}
          </div>
        </div>
        <div className="srow col">Шрифт сообщений
          <div className="seg" role="radiogroup" aria-label="Шрифт сообщений">
            {FONT_OPTIONS.map(([id, label]) => <button key={id} role="radio" aria-selected={a.font === id} aria-checked={a.font === id} onClick={() => setAppearance({ font: id })}>{label}</button>)}
          </div>
        </div>
        <label className="srow col">Размер текста: {Math.round(a.fontScale * 100)}%
          <input className="range" type="range" min={85} max={130} step={5} value={Math.round(a.fontScale * 100)} onChange={(e) => setAppearance({ fontScale: Number(e.target.value) / 100 })} />
        </label>
      </Group>
      <div className="actions left"><button className="ghost" onClick={resetAppearance}>Сбросить оформление</button></div>
    </div>
  );
}

function NotifySection() {
  const toast = useToast();
  const [prefs, setPrefs] = useState(getNotifyPrefs);
  const update = (p: typeof prefs) => { setPrefs(p); setNotifyPrefs(p); };
  const denied = desktopSupported() && Notification.permission === 'denied';
  return (
    <div>
      <Head title="Уведомления" sub="Работают, пока вкладка с мессенджером открыта. Новые сообщения также видны в заголовке вкладки." />
      <Group>
        <label className="srow">
          <span>Звук при новом сообщении</span>
          <input type="checkbox" className="switch" checked={prefs.sound} onChange={(e) => { update({ ...prefs, sound: e.target.checked }); if (e.target.checked) beep(); }} />
        </label>
        <label className="srow">
          <span>Системные уведомления
            <small>{!desktopSupported() ? 'Браузер не поддерживает уведомления' : denied ? 'Запрещено в настройках браузера для этого сайта' : 'Когда вкладка в фоне'}</small>
          </span>
          <input type="checkbox" className="switch" checked={prefs.desktop} disabled={!desktopSupported() || denied}
            onChange={async (e) => {
              if (!e.target.checked) { update({ ...prefs, desktop: false }); return; }
              if (await enableDesktop()) update({ ...prefs, desktop: true });
              else toast('Браузер не разрешил уведомления');
            }} />
        </label>
      </Group>
    </div>
  );
}

function DeviceSection() {
  const { session, logout } = useAuth();
  const { status, error, resetLocal } = useChat();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const until = new Date(session!.expiresAt).toLocaleString('ru', { dateStyle: 'long', timeStyle: 'short' });
  const label = { online: 'Подключено', connecting: 'Подключаемся…', offline: 'Нет соединения' }[status];
  const clear = async () => {
    setBusy(true);
    try { await resetLocal(); toast('Кэш очищен и загружен заново'); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div>
      <Head title="Сессия и данные" sub="Вход действует ограниченное время, затем потребуется войти снова." />
      <Group title="Сессия">
        <div className="srow"><span>Аккаунт</span><b>@{session!.user.login}</b></div>
        <div className="srow"><span>Сессия действует до</span><b>{until}</b></div>
        <div className="srow"><span>Соединение</span><b className={'dot ' + status}>{label}</b></div>
        {error && <div className="srow"><span>Последняя ошибка</span><b>{error}</b></div>}
      </Group>
      <div className="actions left"><button className="btn" onClick={logout}>Выйти из аккаунта</button></div>
      <Group title="Данные на устройстве" hint="Переписка хранится на устройстве и синхронизируется сама. Если что-то отображается неверно, кэш можно очистить: копия загрузится с сервера заново, неотправленные сообщения будут потеряны.">
        <div className="srow">
          <span>Локальный кэш</span>
          <button className="ghost" disabled={busy || status !== 'online'}
            onClick={() => { if (!confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 3000); return; } setConfirm(false); void clear(); }}>
            {confirm ? 'Точно очистить?' : 'Очистить'}
          </button>
        </div>
      </Group>
    </div>
  );
}
