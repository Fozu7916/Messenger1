import { describe, expect, it } from 'vitest';
import { fmtLastSeen, initials, isHttpUrl, sortMessages } from './format';
import type { MessageDoc } from '../types';

const m = (id: string, createdAt: number): MessageDoc => ({
  clientMessageId: id || String(createdAt), id, dialogId: 'd', senderId: 'u', text: '',
  createdAt, status: id ? 'sent' : 'pending', isDeleted: false, editedAt: 0,
});

describe('format', () => {
  it('initials', () => expect(initials('Ада Лавлейс')).toBe('АЛ'));
  it('isHttpUrl принимает только публичный https', () => {
    expect(isHttpUrl('https://a.b/c.png')).toBe(true);
    for (const bad of ['http://a.b/c.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'https://u:p@a.b/c.png',
      'https://a.b:8443/c.png', 'https://localhost/c.png', 'https://nas.local/c.png', 'https://127.0.0.1/c.png',
      'https://192.168.0.1/c.png', 'https://169.254.169.254/x', 'https://[::1]/c.png', 'https://intranet/c.png'])
      expect(isHttpUrl(bad), bad).toBe(false);
  });
  it('fmtLastSeen: только что / сегодня / вчера / дата', () => {
    const now = new Date(2026, 9, 28, 15, 0).getTime();
    expect(fmtLastSeen(now - 10_000, now)).toBe('был(а) в сети только что');
    expect(fmtLastSeen(new Date(2026, 9, 28, 9, 5).getTime(), now)).toMatch(/^был\(а\) в сети сегодня в \d{1,2}:05/);
    expect(fmtLastSeen(new Date(2026, 9, 27, 22, 30).getTime(), now)).toMatch(/вчера в/);
    expect(fmtLastSeen(new Date(2026, 9, 12, 8, 0).getTime(), now)).toMatch(/12 октября в/);
  });
  it('sortMessages: ULID по возрастанию, pending в конце', () => {
    const list = [m('', 5), m('01B', 2), m('01A', 3), m('', 4)].sort(sortMessages);
    expect(list.map((x) => x.id)).toEqual(['01A', '01B', '', '']);
    expect(list[2].createdAt).toBe(4);
  });
});
