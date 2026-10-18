import { useChat } from './chat';
import { Sidebar } from './Sidebar';
import { Thread } from './Thread';

export function Shell() {
  const { activeId } = useChat();
  return (
    <div className="app" data-open={activeId ? 1 : 0}>
      <Sidebar />
      {activeId ? (
        <Thread key={activeId} id={activeId} />
      ) : (
        <main className="main empty">
          <p className="serif display">Выберите диалог</p>
          <p className="muted">Или найдите человека по логину в поиске слева.</p>
        </main>
      )}
    </div>
  );
}
