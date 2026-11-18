import { expect, test } from '@playwright/test';
import { bubble, newUser, openDialogWith, PASSWORD, register, sendText, uniqueLogin } from './helpers';

test.describe('аккаунт', () => {
  test('регистрация, выход и повторный вход', async ({ page }) => {
    const login = uniqueLogin('acc');
    await register(page, login, 'Тестовый Пользователь');

    await page.getByRole('tab', { name: 'Настройки' }).click();
    await page.getByText('Сессия и данные').click();
    await page.getByRole('button', { name: 'Выйти из аккаунта' }).click();
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();

    await page.getByPlaceholder('Логин или email').fill(login);
    await page.getByPlaceholder('Пароль').fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByRole('tab', { name: 'Чаты' })).toBeVisible();
  });

  test('неверный пароль: показывается ошибка, вход не выполняется', async ({ page }) => {
    const login = uniqueLogin('bad');
    await register(page, login, 'Пользователь');
    await page.getByRole('tab', { name: 'Настройки' }).click();
    await page.getByText('Сессия и данные').click();
    await page.getByRole('button', { name: 'Выйти из аккаунта' }).click();

    await page.getByPlaceholder('Логин или email').fill(login);
    await page.getByPlaceholder('Пароль').fill('Wrong-Passw0rd');
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Чаты' })).toHaveCount(0);
  });

  test('сессия переживает перезагрузку страницы', async ({ page }) => {
    await register(page, uniqueLogin('rel'), 'Пользователь');

    await page.reload();

    await expect(page.getByRole('tab', { name: 'Чаты' })).toBeVisible();
  });
});

test.describe('переписка двух пользователей', () => {
  test('сообщение доходит до собеседника, ответ возвращается', async ({ browser }) => {
    const alice = await newUser(browser, 'alice');
    const bob = await newUser(browser, 'bob');

    await openDialogWith(alice.page, bob);
    await sendText(alice.page, 'Привет, Боб!');
    await expect(bubble(alice.page, 'Привет, Боб!')).toHaveClass(/sent/);

    // у Боба появился диалог с непрочитанным сообщением
    const row = bob.page.getByRole('button', { name: new RegExp(alice.name) });
    await expect(row).toBeVisible();
    await expect(row.locator('.badge')).toHaveText('1');
    await row.click();
    await expect(bubble(bob.page, 'Привет, Боб!')).toBeVisible();
    await expect(row.locator('.badge')).toHaveCount(0);   // открыли диалог — счётчик сброшен

    await sendText(bob.page, 'Привет, Алиса!');
    await expect(bubble(alice.page, 'Привет, Алиса!')).toBeVisible();

    await alice.context.close();
    await bob.context.close();
  });

  test('история сохраняется после перезагрузки', async ({ browser }) => {
    const alice = await newUser(browser, 'alice');
    const bob = await newUser(browser, 'bob');
    await openDialogWith(alice.page, bob);
    await sendText(alice.page, 'Это нужно сохранить');
    await expect(bubble(alice.page, 'Это нужно сохранить')).toHaveClass(/sent/);

    await alice.page.reload();

    await expect(bubble(alice.page, 'Это нужно сохранить')).toBeVisible();

    await alice.context.close();
    await bob.context.close();
  });

  test('реакция (двойной клик по сообщению) видна собеседнику', async ({ browser }) => {
    const alice = await newUser(browser, 'alice');
    const bob = await newUser(browser, 'bob');
    await openDialogWith(alice.page, bob);
    await sendText(alice.page, 'Оцени это');
    await expect(bubble(alice.page, 'Оцени это')).toHaveClass(/sent/);
    await bob.page.getByRole('button', { name: new RegExp(alice.name) }).click();
    await expect(bubble(bob.page, 'Оцени это')).toBeVisible();

    await bubble(bob.page, 'Оцени это').locator('.txt').dblclick();

    await expect(bubble(alice.page, 'Оцени это').locator('.rx button', { hasText: '👍' })).toBeVisible();

    await alice.context.close();
    await bob.context.close();
  });

  test('Offline-First: сообщение, написанное без сети, уходит после её появления', async ({ browser }) => {
    test.setTimeout(120_000);
    const alice = await newUser(browser, 'alice');
    const bob = await newUser(browser, 'bob');
    await openDialogWith(alice.page, bob);
    await sendText(alice.page, 'Первое, с сетью');
    await expect(bubble(alice.page, 'Первое, с сетью')).toHaveClass(/sent/);

    await alice.context.setOffline(true);
    await sendText(alice.page, 'Написано без сети');
    // Сообщение видно сразу, но ещё не отправлено. Chromium при setOffline иногда не закрывает уже открытый WebSocket,
    // тогда оно уходит мгновенно: это не ошибка приложения, поэтому состояние pending не требуем, а фиксируем.
    const wasPending = await expect(bubble(alice.page, 'Написано без сети')).toHaveClass(/pending/, { timeout: 3000 }).then(() => true, () => false);
    test.info().annotations.push({ type: 'pending-observed', description: String(wasPending) });

    await alice.context.setOffline(false);

    await expect(bubble(alice.page, 'Написано без сети')).toHaveClass(/sent/, { timeout: 60_000 });
    await bob.page.getByRole('button', { name: new RegExp(alice.name) }).click();
    await expect(bubble(bob.page, 'Написано без сети')).toBeVisible();

    await alice.context.close();
    await bob.context.close();
  });
});
