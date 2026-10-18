import { useState, type ChangeEvent, type FormEvent } from 'react';
import { ApiError, api, type Session } from './api';

export function Auth({ onAuth }: { onAuth(s: Session): void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [f, setF] = useState({ login: '', email: '', password: '', displayName: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const reg = mode === 'register';
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      onAuth(reg
        ? await api.register({ ...f, displayName: f.displayName.trim() || f.login })
        : await api.login({ login: f.login, password: f.password }));
    } catch (x) {
      const s = x instanceof ApiError ? x.status : 0;
      setErr(s === 401 ? 'Неверный логин или пароль'
        : s === 409 ? 'Логин или email уже заняты'
        : s === 429 ? 'Слишком много попыток. Подождите минуту'
        : x instanceof Error ? x.message : 'Не удалось выполнить запрос');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <section className="hero">
        <p className="stamp">Secure channel</p>
        <h1>
          <span className="serif display">Ваш новый</span>
          <span className="title">Приватный мессенджер</span>
          <span className="serif display">без установки</span>
        </h1>
        <p className="lead">Переписка в реальном времени прямо в браузере. Сообщения не теряются, если пропала сеть.</p>
      </section>

      <form className="pass" onSubmit={submit}>
        <div className="pass-top">
          <span className="cap">{reg ? 'Регистрация' : 'Вход'}</span>
          <span className="cap">{reg ? 'Гость → участник' : 'Участник → чат'}</span>
        </div>
        <label>
          <span className="cap">{reg ? 'Логин' : 'Логин или email'}</span>
          <input className="input" value={f.login} onChange={set('login')} required autoComplete="username"
            {...(reg ? { pattern: '[A-Za-z0-9_]{3,32}', title: '3–32 символа: латиница, цифры и _' } : {})} />
        </label>
        {reg && (
          <>
            <label><span className="cap">Email</span>
              <input className="input" type="email" value={f.email} onChange={set('email')} required autoComplete="email" /></label>
            <label><span className="cap">Имя в чате</span>
              <input className="input" value={f.displayName} onChange={set('displayName')} maxLength={64} /></label>
          </>
        )}
        <label><span className="cap">Пароль</span>
          <input className="input" type="password" value={f.password} onChange={set('password')} required
            minLength={reg ? 8 : undefined} maxLength={72} autoComplete={reg ? 'new-password' : 'current-password'} /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy}>{reg ? 'Создать аккаунт' : 'Войти'}</button>
        <button type="button" className="btn pill ghost" onClick={() => { setMode(reg ? 'login' : 'register'); setErr(''); }}>
          {reg ? 'Уже есть аккаунт' : 'Создать аккаунт'}
        </button>
      </form>
    </div>
  );
}
