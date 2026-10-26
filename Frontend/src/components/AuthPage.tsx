
import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../lib/auth';

const POINTS = [
  'Сообщения приходят мгновенно',
  'История всегда под рукой',
  'Доступ к диалогу — только у участников',
];

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
    password: checkPass(v.password),
    id: !reg && !v.id.trim() ? 'Введите логин или email' : '',
  };

  const hasErrors = reg
    ? !!(errors.login || errors.email || errors.password)
    : !!(errors.id || errors.password);

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

  const field = (
    k: keyof typeof errors,
    input: ReactNode,
    hint?: string,
  ) => (
    <div className="fld">
      {input}

      {show(k) ? (
        <div
          className="err"
          id={`${k}-e`}
          role="alert"
        >
          {show(k)}
        </div>
      ) : hint ? (
        <p className="hint">{hint}</p>
      ) : null}
    </div>
  );

  return (
    <div className="auth">
      <div className="banner">
        Личная переписка без установки приложений
      </div>

      <div className="hero">
        <div>
          <h1>Безопасность превыше всего</h1>

          <ul>
            {POINTS.map((t) => (
              <li key={t}>
                <b>
                  <svg viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M2 6.5l2.6 2.6L10 3.5" />
                  </svg>
                </b>
                {t}
              </li>
            ))}
          </ul>

          <div className="preview" aria-hidden="true">
            <div className="msg in">
              Привет! Ты уже в сети?
            </div>
            <div className="msg out">
              Да, вечером в доту?
            </div>
            <div className="msg in">
              Сёдня не, у мя идз просрочено
            </div>
          </div>
        </div>

        <form
          className="card"
          onSubmit={submit}
          noValidate
          key={mode}
          autoComplete="on"
        >
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className="ghost"
              aria-selected={!reg}
              onClick={() => switchMode('login')}
            >
              Вход
            </button>

            <button
              type="button"
              role="tab"
              className="ghost"
              aria-selected={reg}
              onClick={() => switchMode('register')}
            >
              Регистрация
            </button>
          </div>

          <h2>
            {reg ? 'Создайте аккаунт' : 'С возвращением'}
          </h2>

          <p className="sub" />

          <div className="form">
            {reg &&
              field(
                'login',
                <input
                  className="field"
                  name="username"
                  placeholder="Логин"
                  autoComplete="username"
                  maxLength={32}
                  value={v.login}
                  onChange={set('login')}
                  onBlur={blur('login')}
                  aria-invalid={!!show('login')}
                  aria-describedby={
                    show('login') ? 'login-e' : undefined
                  }
                />,
                '3–32 символа: латиница, цифры, _',
              )}

            {reg
              ? field(
                  'email',
                  <input
                    className="field"
                    name="email"
                    type="email"
                    inputMode="email"
                    placeholder="Email"
                    autoComplete="email"
                    maxLength={254}
                    value={v.email}
                    onChange={set('email')}
                    onBlur={blur('email')}
                    aria-invalid={!!show('email')}
                    aria-describedby={
                      show('email') ? 'email-e' : undefined
                    }
                  />,
                )
              : field(
                  'id',
                  <input
                    className="field"
                    name="username"
                    placeholder="Логин или email"
                    autoComplete="username"
                    value={v.id}
                    onChange={set('id')}
                    onBlur={blur('id')}
                    aria-invalid={!!show('id')}
                    aria-describedby={
                      show('id') ? 'id-e' : undefined
                    }
                  />,
                )}

            {field(
              'password',
              <input
                className="field"
                name="password"
                type="password"
                maxLength={72}
                placeholder="Пароль"
                autoComplete={
                  reg ? 'new-password' : 'current-password'
                }
                value={v.password}
                onChange={set('password')}
                onBlur={blur('password')}
                aria-invalid={!!show('password')}
                aria-describedby={
                  show('password') ? 'password-e' : undefined
                }
              />,
              reg ? PASS_HINT : undefined,
            )}

            {reg && (
              <input
                className="field"
                name="displayName"
                placeholder="Имя (необязательно)"
                autoComplete="nickname"
                maxLength={64}
                value={v.name}
                onChange={set('name')}
              />
            )}

            {err && (
              <div className="err" role="alert">
                {err}
              </div>
            )}

            <button
              className="btn big"
              type="submit"
              disabled={busy}
            >
              {busy
                ? 'Подождите…'
                : reg
                  ? 'Зарегистрироваться'
                  : 'Войти'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}