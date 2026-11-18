# Frontend — React + TypeScript + RxDB + SignalR

Вкладки: **Чаты**, **Люди** и **Настройки** (профиль, оформление, уведомления, сессия). Тема (авто/светлая/тёмная), акцент и обои настраиваются в «Оформлении» (`src/lib/theme.ts`).

```bash
npm install
npm run dev     # http://localhost:5173, /api и /hubs проксируются на http://localhost:5080 (см. .env.example)
npm test                # юнит- и интеграционные тесты (Vitest, jsdom)
npm run test:coverage   # то же + покрытие (в консоли и в coverage/index.html)
npm run build
```

## Как устроено

| Файл | Назначение |
|------|------------|
| `src/lib/api.ts` | REST-клиент, ошибки `problem+json`, Bearer-токен, 401 → выход |
| `src/lib/auth.tsx` | Сессия (localStorage), вход/регистрация/выход, `PUT /api/users/me` |
| `src/lib/db.ts` | RxDB (Dexie/IndexedDB), отдельная БД на пользователя |
| `src/lib/chat.tsx` | SignalR + синхронизация: Optimistic UI, `clientMessageId`, дельта по `LastSyncULID`, повтор `pending`, сверка удалений |
| `src/lib/media.ts` | Загрузка вложений с токеном и кэш (Cache Storage), запись голосовых |
| `src/lib/theme.ts` | Оформление: тема, акцент, обои; синхронизация с сервером |
| `src/components/*` | `AuthPage`, `ChatsPage`, `PeoplePage`, `SettingsPage`, `MediaBits` и др. |

## Допущения — сверьте со Swagger

- `POST /api/auth/register` принимает `{ login, email, password, displayName }`; `POST /api/auth/login` — `{ login, password }` (в поле `login` логин или email).
- Начальный снимок присутствия клиент берёт методами хаба `GetOnlineContacts` и `GetLastSeen`, дальше — события `PresenceChanged`.
- Фото и голосовые отправляются через `POST /api/dialogs/{id}/messages/media`; без настроенного хранилища на бэкенде (локально) они отвечают 503. Видео не поддерживается.
- Список диалогов считает последнее сообщение по локальной БД — для очень больших историй стоит заменить на поле `lastMessage` в документе диалога.

## Offline-First

- Сообщения и диалоги сначала пишутся в RxDB, интерфейс читает только из неё.
- Диалог можно открыть без сети: он получает временный id `L<peerId>` и создаётся на сервере при появлении связи, после чего сообщения переезжают на серверный id.
- Начальная REST-синхронизация не зависит от SignalR; хаб нужен только для отправки и событий реального времени.
- Локальная БД называется `messenger5-<userId>`; старые `messenger-…` … `messenger4-…` можно удалить в DevTools → Application → IndexedDB.
