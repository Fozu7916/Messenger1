import { describe, expect, it } from 'vitest';
import { initials, isHttpUrl, sortMessages } from './format';
import type { MessageDoc } from '../types';

const m = (id: string, createdAt: number): MessageDoc => ({
  clientMessageId: id || String(createdAt), id, dialogId: 'd', senderId: 'u', text: '',
  createdAt, status: id ? 'sent' : 'pending', isDeleted: false, editedAt: 0,
});

describe('format', () => {
  it('initials', () => expect(initials('Ада Лавлейс')).toBe('АЛ'));
  it('isHttpUrl принимает только http/https', () => {
    expect(isHttpUrl('https://a.b/c.png')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
  });
  it('sortMessages: ULID по возрастанию, pending в конце', () => {
    const list = [m('', 5), m('01B', 2), m('01A', 3), m('', 4)].sort(sortMessages);
    expect(list.map((x) => x.id)).toEqual(['01A', '01B', '', '']);
    expect(list[2].createdAt).toBe(4);
  });
});
