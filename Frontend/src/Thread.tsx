import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ui } from './api';
import { useChat } from './chat';
import type { MsgDb } from './db';
import { Avatar, time } from './Sidebar';
import type { LocalMessage } from './types';

function useMessages(db: MsgDb | null, dialogId: string) {
  const [list, setList] = useState<LocalMessage[]>([]);
  useEffect(() => {
    setList([]);
    if (!db) return;
    const sub = db.messages
      .find({ selector: { dialogId }, sort: [{ createdAt: 'asc' }] })
      .$.subscribe((docs) => setList(docs.map((d) => d.toJSON() as LocalMessage)));
    return () => sub.unsubscribe();
  }, [db, dialogId]);
  return list;
}

const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

export function Thread({ id }: { id: string }) {
  const c = useChat();
  const dlg = c.dialogs.find((d) => d.id === id);
  const msgs = useMessages(c.db, id);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);          // прижаты ли к низу
  const anchor = useRef<number | null>(null); // сохраняем позицию при подгрузке истории вверх
  const loading = useRef(false);
  const restored = useRef(false);
  const typing = c.typing[id];

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (anchor.current !== null) { el.scrollTop = el.scrollHeight - anchor.current; anchor.current = null; return; }
    if (!restored.current) {
      if (!msgs.length) return;
      restored.current = true;
      const off = ui.load().scroll[id];
      stick.current = off === undefined || off < 80;
      el.scrollTop = el.scrollHeight - el.clientHeight - (off ?? 0);
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, typing]);

  function onScroll() {
    const el = box.current!;
    const off = el.scrollHeight - el.clientHeight - el.scrollTop;
    stick.current = off < 80;
    ui.setScroll(id, Math.round(off));
    if (el.scrollTop < 80 && !loading.current && !c.exhausted[id] && msgs.some((m) => m.status === 'sent')) {
      loading.current = true;
      anchor.current = el.scrollHeight - el.scrollTop;
      void c.loadOlder(id).finally(() => setTimeout(() => { loading.current = false; anchor.current = null; }, 200));
    }
  }

  function submit() {
    const t = text.trim();
    if (!t) return;
    stick.current = true;
    void c.send(id, t);
    setText('');
    if (ta.current) ta.current.style.height = 'auto';
  }

  async function removeDialog() {
    if (confirm('Удалить диалог? Он исчезнет у обоих участников вместе со всеми сообщениями.')) await c.removeDialog(id);
  }

  const peer = dlg?.peer ?? null;
  return (
    <main className="main">
      <header className="bar">
        <button className="back" onClick={() => c.open(null)} aria-label="К списку диалогов">←</button>
        <Avatar u={peer} size={36} />
        <div className="grow">
          <b>{peer?.displayName ?? 'Диалог'}</b>
          <span className="cap line">{typing ? 'Печатает…' : peer && c.online[peer.id] ? 'В сети' : peer ? `@${peer.login}` : ''}</span>
        </div>
        <button className="btn sm" onClick={() => void removeDialog()}>Удалить диалог</button>
      </header>

      <div className="feed" ref={box} onScroll={onScroll}>
        {c.exhausted[id] && msgs.length > 0 && <p className="cap center">Начало переписки</p>}
        {!msgs.length && <p className="note center">Сообщений пока нет. Напишите первым.</p>}
        {msgs.map((m, i) => {
          const mine = m.senderId === c.me.id;
          const newDay = i === 0 || day(m.createdAt) !== day(msgs[i - 1].createdAt);
          return (
            <div key={m.clientMessageId}>
              {newDay && <p className="cap center sep">{day(m.createdAt)}</p>}
              <div className="msg" data-mine={mine}>
                <div className="bubble" data-status={m.status}>
                  <p>{m.text}</p>
                  <span className="meta cap">
                    {time(m.createdAt)}
                    {mine && m.status === 'pending' && ' · отправляется'}
                    {mine && m.status === 'sent' && ' · ✓'}
                    {mine && m.status === 'failed' && <button className="link" onClick={() => void c.retry(m)}> · не отправлено, повторить</button>}
                    {mine && <button className="link del" onClick={() => void c.removeMessage(m)}> · удалить</button>}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <textarea
          ref={ta} rows={1} maxLength={4000} value={text} placeholder="Сообщение"
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
            c.notifyTyping(id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }}
        />
        <button className="btn primary" disabled={!text.trim()}>Отправить</button>
      </form>
    </main>
  );
}
