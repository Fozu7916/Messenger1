
import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { Icon } from './ui';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[A-Za-z]{2,}$/;
const LOGIN_RE = /^[a-zA-Z0-9_]{3,32}$/;
const PASS_HINT = 'От 8 до 72 символов';

const checkEmail = (v: string) =>
  !v.trim()
    ? 'Введите email'
    : EMAIL_RE.test(v.trim())
      ? ''
      : 'Введите корректный email, например name@example.com';

const checkLogin = (v: string) =>
  LOGIN_RE.test(v.trim())
    ? ''
    : '3–32 символа: латиница, цифры, _';

const checkPass = (v: string) =>
  !v
    ? 'Введите пароль'
    : v.length < 8
      ? `Пароль слишком короткий: ${v.length} из 8 символов`
      : '';

export function AuthPage() {
  const { login, register } = useAuth();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [v, setV] = useState({
    id: '',
    login: '',
    email: '',
    name: '',
    password: '',
  });

  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const reg = mode === 'register';

  const errors = {
    login: reg ? checkLogin(v.login) : '',
    email: reg ? checkEmail(v.email) : '',
    password: reg ? checkPass(v.password) : '',
    id: !reg && !v.id.trim() ? 'Введите логин или email' : '',
  };

  // При входе длину пароля не проверяем — достаточно, чтобы он был введён (решает сервер).
  const hasErrors = reg
    ? !!(errors.login || errors.email || errors.password)
    : !!(errors.id || !v.password);

  const show = (k: keyof typeof errors) =>
    touched[k] ? errors[k] : '';

  const set = (k: keyof typeof v) =>
    (e: { target: { value: string } }) => {
      setV((prev) => ({ ...prev, [k]: e.target.value }));
      setErr('');
    };

  const blur = (k: string) => () => {
    setTouched((prev) => ({ ...prev, [k]: true }));
  };

  const switchMode = (m: 'login' | 'register') => {
    setMode(m);
    setErr('');
    setTouched({});
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    setTouched({
      login: true,
      email: true,
      password: true,
      id: true,
    });

    if (hasErrors || busy) return;

    setBusy(true);
    setErr('');

    try {
      if (reg) {
        await register({
          login: v.login.trim(),
          email: v.email.trim(),
          password: v.password,
          displayName: v.name.trim() || undefined,
        });
      } else {
        await login(v.id.trim(), v.password);
      }
    } catch (x) {
      setErr(
        x instanceof Error
          ? x.message
          : 'Произошла ошибка. Попробуйте ещё раз.',
      );
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof typeof errors, label: string, input: ReactNode, hint?: string) => (
    <label className="lbl fld">
      {label}
      {input}
      {show(k) ? <span className="err" id={`${k}-e`} role="alert">{show(k)}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
  const aria = (k: keyof typeof errors) => ({ 'aria-invalid': !!show(k), 'aria-describedby': show(k) ? `${k}-e` : undefined });

  return (
    <main className="auth">
      <div className="auth-box">
        <div className="brand"><span className="brand-mark"><Icon.Chat /></span>Мессенджер</div>
        <form className="auth-card" onSubmit={submit} noValidate key={mode} autoComplete="on">
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={!reg} onClick={() => switchMode('login')}>Вход</button>
            <button type="button" role="tab" aria-selected={reg} onClick={() => switchMode('register')}>Регистрация</button>
          </div>
          <h2>{reg ? 'Создать аккаунт' : 'С возвращением'}</h2>
          <p className="lead">{reg ? 'Пара полей — и можно переписываться.' : 'Войдите по логину или email.'}</p>
          <div className="form">
            {reg && field('login', 'Логин',
              <input className="field" name="username" autoComplete="username" maxLength={32}
                value={v.login} onChange={set('login')} onBlur={blur('login')} {...aria('login')} />,
              'Латиница, цифры и _, от 3 до 32 символов')}
            {reg
              ? field('email', 'Email',
                <input className="field" name="email" type="email" inputMode="email" autoComplete="email" maxLength={254}
                  value={v.email} onChange={set('email')} onBlur={blur('email')} {...aria('email')} />,
                'Например, name@example.com')
              : field('id', 'Логин или email',
                <input className="field" name="username" autoComplete="username" autoFocus
                  value={v.id} onChange={set('id')} onBlur={blur('id')} {...aria('id')} />)}
            {field('password', 'Пароль',
              <input className="field" name="password" type="password" maxLength={72}
                autoComplete={reg ? 'new-password' : 'current-password'}
                value={v.password} onChange={set('password')} onBlur={blur('password')} {...aria('password')} />,
              reg ? PASS_HINT : undefined)}
            {reg && (
              <label className="lbl fld">
                <span>Имя <span style={{ fontWeight: 400 }}>· необязательно</span></span>
                <input className="field" name="displayName" autoComplete="nickname" maxLength={64} value={v.name} onChange={set('name')} />
              </label>
            )}
            {err && <p className="err" role="alert">{err}</p>}
            <button className="btn block" type="submit" disabled={busy}>
              {busy ? 'Подождите…' : reg ? 'Зарегистрироваться' : 'Войти'}
            </button>
          </div>
        </form>
        <p className="auth-foot">Переписка доступна только её участникам.</p>
      </div>
    </main>
  );
}
