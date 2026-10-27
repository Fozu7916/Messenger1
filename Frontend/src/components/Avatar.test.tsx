import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Avatar } from './ui';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const rule = (sel: string) => css.split('\n').find((l) => l.startsWith(sel + '{')) ?? '';
const html = (p: Parameters<typeof Avatar>[0]) => renderToStaticMarkup(createElement(Avatar, p));

describe('Avatar: единая форма', () => {
  it.each([32, 40, 88])('размер %i: ширина = высоте, и с фото, и без', (size) => {
    for (const url of [undefined, null, 'https://example.com/a.png']) {
      const out = html({ name: 'Иван Петров', url, size });
      expect(out).toContain(`width:${size}px`);
      expect(out).toContain(`height:${size}px`);
      expect(out).toContain('class="ava"');
    }
  });

  it('по умолчанию квадрат 40×40', () => {
    expect(html({ name: 'A' })).toMatch(/width:40px;height:40px/);
  });

  it('CSS: круг, квадратные пропорции, фото заполняет круг без искажений', () => {
    expect(rule('.ava')).toContain('border-radius:9999px');
    expect(rule('.ava')).toContain('aspect-ratio:1/1');
    expect(rule('.ava')).toContain('flex:none');   // не сжимается во flex-строке
    expect(rule('.ava img')).toMatch(/width:100%;height:100%/);
    expect(rule('.ava img')).toContain('object-fit:cover');
    expect(rule('.ava img')).toContain('border-radius:inherit');
  });

  it('фото безопасно: без referrer, ленивая загрузка', () => {
    const out = html({ name: 'A', url: 'https://example.com/a.png' });
    expect(out).toContain('referrerPolicy="no-referrer"');
    expect(out).toContain('loading="lazy"');
  });

  it('небезопасные (старые) ссылки не грузятся — показываются инициалы', () => {
    for (const url of ['http://example.com/a.png', 'https://localhost/a.png', 'https://u:p@example.com/a.png', 'https://10.0.0.1/a.png']) {
      const out = html({ name: 'Иван Петров', url });
      expect(out).not.toContain('<img');
      expect(out).toContain('ИП');
    }
  });

  it('без фото — инициалы, одинаковая обёртка', () => {
    expect(html({ name: 'Иван Петров' })).toContain('ИП');
  });
});
