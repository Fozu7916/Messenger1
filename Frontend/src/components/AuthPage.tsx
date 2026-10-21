import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';

const POINTS = ['Сообщения приходят мгновенно', 'Работает и без сети — отправится позже', 'История всегда под рукой', 'Доступ к диалогу — только у двоих'];

export function AuthPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const reg = mode === 'register';

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const g = (k: string) => String(f.get(k) ?? '');
    setBusy(true); setErr('');
    try {
      if (reg) await register({ login: g('login'), email: g('email'), password: g('password'), displayName: g('displayName') });
      else await login(g('login'), g('password'));
    } catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth">
      <div className="banner">Личная переписка без установки приложений</div>
      <div className="hero">
        <div>
          <h1>Безопасность привыше всего</h1>
          <ul>
            {POINTS.map((t) => (
              <li key={t}><b><svg viewBox="0 0 12 12"><path d="M2 6.5l2.6 2.6L10 3.5" /></svg></b>{t}</li>
            ))}
          </ul>
          <div className="preview" aria-hidden="true">
            <div className="msg in">Привет! Ты уже в сети?</div>
            <div className="msg out">Да, вечером в доту?</div>
            <div className="msg in">Сёдня не, у мя идз просрочено</div>
          </div>
        </div>
        <form className="card" onSubmit={submit} key={mode}>
          <div className="tabs" role="tablist">
            <button type="button" role="tab" className="ghost" aria-selected={!reg} onClick={() => { setMode('login'); setErr(''); }}>Вход</button>
            <button type="button" role="tab" className="ghost" aria-selected={reg} onClick={() => { setMode('register'); setErr(''); }}>Регистрация</button>
          </div>
          <h2>{reg ? 'Создайте аккаунт' : 'С возвращением'}</h2>
          <p className="sub">{reg ? 'Займёт меньше минуты.' : 'Войдите по логину или email.'}</p>
          <div className="form">
            <input className="field" name="login" placeholder={reg ? 'Логин' : 'Логин или email'} autoComplete="username" required />
            {reg && <input className="field" name="email" type="email" placeholder="Email" autoComplete="email" required />}
            {reg && <input className="field" name="displayName" placeholder="Имя в профиле" autoComplete="nickname" />}
            <input className="field" name="password" type="password" maxLength={72} placeholder="Пароль" autoComplete={reg ? 'new-password' : 'current-password'} required />
            <div className="err" role="alert">{err}</div>
            <button className="btn big" disabled={busy}>{busy ? 'Подождите…' : reg ? 'Зарегистрироваться' : 'Войти'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
