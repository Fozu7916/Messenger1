import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import * as api from '../lib/api';

/** Те же правила, что на сервере: 8–72 символа, буква и цифра. */
export const checkPassword = (v: string) =>
  !v
    ? 'Введите пароль'
    : v.length < 8
      ? `Пароль слишком короткий: ${v.length} из 8 символов`
      : !/\p{L}/u.test(v) || !/\p{Nd}/u.test(v)
        ? 'Нужна хотя бы одна буква и одна цифра'
        : '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="hero">
        <div />
        <div className="card">{children}</div>
      </div>
    </div>
  );
}

/** Запрос письма со ссылкой для сброса пароля. Ответ всегда одинаковый — не раскрываем, есть ли такой email. */
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) return setErr('Введите корректный email, например name@example.com');
    setBusy(true);
    setErr('');
    try {
      await api.forgotPassword(email.trim());
      setSent(true);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      <h2>Восстановление пароля</h2>
      {sent ? (
        <>
          <p className="sub">Если такой email зарегистрирован, мы отправили письмо со ссылкой. Она действует 30 минут.</p>
          <button className="btn big" onClick={onBack}>Вернуться ко входу</button>
        </>
      ) : (
        <form className="form" onSubmit={submit} noValidate>
          <p className="sub">Укажите email аккаунта — пришлём ссылку для нового пароля.</p>
          <input className="field" type="email" inputMode="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => { setEmail(e.target.value); setErr(''); }} />
          {err && <div className="err" role="alert">{err}</div>}
          <button className="btn big" disabled={busy}>{busy ? 'Подождите…' : 'Отправить ссылку'}</button>
          <button type="button" className="ghost" onClick={onBack}>Назад</button>
        </form>
      )}
    </Frame>
  );
}

// Токен приходит во фрагменте (#token=…), чтобы не попадать в логи. Забираем и сразу стираем из адресной строки.
function takeToken(): string {
  const t = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
  history.replaceState(null, '', location.pathname);
  return t;
}

const goHome = () => location.assign('/');

/** Страницы по ссылке из письма: /reset и /confirm. Показываются и вошедшему пользователю. */
export function LinkPage({ kind }: { kind: 'reset' | 'confirm' }) {
  const [token] = useState(takeToken);
  return kind === 'reset' ? <ResetForm token={token} /> : <ConfirmEmail token={token} />;
}

function ConfirmEmail({ token }: { token: string }) {
  const [state, setState] = useState<'wait' | 'ok' | 'bad'>(token ? 'wait' : 'bad');
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;   // токен одноразовый — второй запрос гарантированно упал бы
    api.confirmEmail(token).then(() => setState('ok'), () => setState('bad'));
  }, [token]);

  return (
    <Frame>
      <h2>Подтверждение почты</h2>
      <p className="sub">
        {state === 'wait' ? 'Проверяем ссылку…' : state === 'ok' ? 'Почта подтверждена. Спасибо!' : 'Ссылка недействительна или устарела. Запросите новое письмо на странице входа.'}
      </p>
      {state !== 'wait' && <button className="btn big" onClick={goHome}>{state === 'ok' ? 'Продолжить' : 'На главную'}</button>}
    </Frame>
  );
}

function ResetForm({ token }: { token: string }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const bad = checkPassword(pw) || (pw !== pw2 ? 'Пароли не совпадают' : '');
    if (bad) return setErr(bad);
    setBusy(true);
    setErr('');
    try {
      await api.resetPassword(token, pw);
      setDone(true);
    } catch (x) {
      // пароль уже проверен на клиенте, так что 400 здесь — почти всегда просроченный или использованный токен
      setErr((x as api.ApiError).status === 400 ? 'Ссылка недействительна или устарела. Запросите новую.' : (x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!token) return <Frame><h2>Новый пароль</h2><p className="sub">Ссылка недействительна. Запросите новую на странице входа.</p><button className="btn big" onClick={goHome}>На главную</button></Frame>;

  return (
    <Frame>
      <h2>Новый пароль</h2>
      {done ? (
        <>
          <p className="sub">Пароль изменён, все устройства разлогинены. Войдите с новым паролем.</p>
          <button className="btn big" onClick={goHome}>Войти</button>
        </>
      ) : (
        <form className="form" onSubmit={submit} noValidate>
          <input className="field" type="password" maxLength={72} autoComplete="new-password" placeholder="Новый пароль" value={pw} onChange={(e) => { setPw(e.target.value); setErr(''); }} />
          <p className="hint">От 8 до 72 символов, буква и цифра</p>
          <input className="field" type="password" maxLength={72} autoComplete="new-password" placeholder="Повторите пароль" value={pw2} onChange={(e) => { setPw2(e.target.value); setErr(''); }} />
          {err && <div className="err" role="alert">{err}</div>}
          <button className="btn big" disabled={busy}>{busy ? 'Подождите…' : 'Сохранить пароль'}</button>
        </form>
      )}
    </Frame>
  );
}
