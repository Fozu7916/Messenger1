import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const PASSWORD = 'Passw0rd-e2e';

/** Уникальный логин (3–32 символа: латиница, цифры, «_») — тесты не мешают друг другу и повторным запускам. */
export const uniqueLogin = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface Account { login: string; name: string; page: Page; context: BrowserContext }

/** Регистрируется через форму и ждёт, пока откроется приложение с подключённым хабом. */
export async function register(page: Page, login: string, name: string) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Регистрация' }).click();
  await page.getByPlaceholder('Логин').fill(login);
  await page.getByPlaceholder('Email').fill(`${login}@example.com`);
  await page.getByPlaceholder('Пароль').fill(PASSWORD);
  await page.getByPlaceholder('Имя (необязательно)').fill(name);
  await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
  await expect(page.getByRole('tab', { name: 'Чаты' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'На связи' })).toHaveCount(1);
}

/** Новый пользователь в отдельном контексте (свои cookie и локальная база), как отдельный браузер. */
export async function newUser(browser: Browser, prefix: string): Promise<Account> {
  const context = await browser.newContext({ locale: 'ru-RU', baseURL: 'http://localhost:5173' });
  const page = await context.newPage();
  const login = uniqueLogin(prefix);
  const name = `${prefix.toUpperCase()} ${login.slice(-4)}`;
  await register(page, login, name);
  return { login, name, page, context };
}

/** «Люди» → поиск по логину → «Написать»: открывает диалог с пользователем. */
export async function openDialogWith(page: Page, peer: { login: string; name: string }) {
  await page.getByRole('tab', { name: 'Люди' }).click();
  await page.getByLabel('Поиск людей').fill(peer.login);
  await page.getByRole('button', { name: new RegExp(`@${peer.login}`) }).click();
  await page.getByRole('button', { name: 'Написать' }).click();
  await expect(page.getByRole('button', { name: new RegExp(`Профиль: ${peer.name}`) })).toBeVisible();
}

export async function sendText(page: Page, text: string) {
  const box = page.getByLabel('Сообщение', { exact: true });
  await box.fill(text);
  await box.press('Enter');
}

/** Пузырь сообщения с точным текстом. */
export const bubble = (page: Page, text: string) => page.locator('.msg', { has: page.locator('.txt', { hasText: text }) });
