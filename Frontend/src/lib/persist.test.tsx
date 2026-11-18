// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearUiState, readScroll, saveScroll, usePersisted } from './persist';

function Probe({ k, init }: { k: string; init: string }) {
  const [v, set] = usePersisted(k, init);
  return <button onClick={() => set('next')}>{v}</button>;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('usePersisted', () => {
  it('без сохранённого значения отдаёт начальное и ничего не пишет', () => {
    const { container } = render(<Probe k="tab" init="chats" />);
    expect(container.textContent).toBe('chats');
    expect(localStorage.getItem('ui:tab')).toBeNull();
  });

  it('читает сохранённое значение', () => {
    localStorage.setItem('ui:tab', JSON.stringify('people'));
    const { container } = render(<Probe k="tab" init="chats" />);
    expect(container.textContent).toBe('people');
  });

  it('повреждённый JSON не ломает рендер', () => {
    localStorage.setItem('ui:tab', '{oops');
    const { container } = render(<Probe k="tab" init="chats" />);
    expect(container.textContent).toBe('chats');
  });

  it('запись обновляет состояние и localStorage с префиксом ui:', () => {
    const { container } = render(<Probe k="tab" init="chats" />);
    act(() => { fireEvent.click(container.querySelector('button')!); });
    expect(container.textContent).toBe('next');
    expect(JSON.parse(localStorage.getItem('ui:tab')!)).toBe('next');
  });
});

describe('позиция прокрутки и очистка', () => {
  it('saveScroll → readScroll', () => {
    saveScroll('D1', { top: 120, bottom: false });
    expect(readScroll('D1')).toEqual({ top: 120, bottom: false });
    expect(readScroll('D2')).toBeNull();
  });

  it('readScroll не падает на мусоре', () => {
    localStorage.setItem('ui:scroll:D1', 'не json');
    expect(readScroll('D1')).toBeNull();
  });

  it('clearUiState стирает только ключи ui:, настройки и сессию не трогает', () => {
    localStorage.setItem('ui:tab', '"x"');
    localStorage.setItem('ui:scroll:D1', '{}');
    localStorage.setItem('pref:notify', '{}');
    localStorage.setItem('appearance', '{}');

    clearUiState();

    expect(localStorage.getItem('ui:tab')).toBeNull();
    expect(localStorage.getItem('ui:scroll:D1')).toBeNull();
    expect(localStorage.getItem('pref:notify')).toBe('{}');
    expect(localStorage.getItem('appearance')).toBe('{}');
  });
});
