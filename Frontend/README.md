# Frontend — React + TypeScript + RxDB + SignalR

Стиль интерфейса — Dimension (тёмный холст, матовое стекло, пилюли). Вкладки: **Чаты** и **Настройки** (профиль и его редактирование, синхронизация, сессия).

```bash
npm install
npm run dev     # http://localhost:5173, /api и /hubs проксируются на http://localhost:5080
npm test
npm run build
```

## Как устроено

| Файл | Назначение |
|------|------------|
| `src/lib/api.ts` | REST-клиент, ошибки `problem+json`, Bearer-токен, 401 → выход |
| `src/lib/auth.tsx` | Сессия (localStorage), вход/регистрация/выход, `PUT /api/users/me` |
| `src/lib/db.ts` | RxDB (Dexie/IndexedDB), отдельная БД на пользователя |
| `src/lib/chat.tsx` | SignalR + синхронизация: Optimistic UI, `clientMessageId`, дельта по `LastSyncULID`, повтор `pending`, сверка удалений |
| `src/components/*` | `AuthPage`, `ChatsPage`, `SettingsPage`, общие `Avatar`/`Toast` |

## Допущения — сверьте со Swagger

- `POST /api/auth/register` принимает `{ login, email, password, displayName }`; `POST /api/auth/login` — `{ login, password }` (в поле `login` логин или email).
- Подсказка «в сети» по умолчанию «не в сети», пока не придёт `PresenceChanged` (начального снимка статусов в API нет).
- Загрузка медиа не подключена: `POST /api/media/upload-url` на бэкенде ещё не реализован.
- Список диалогов считает последнее сообщение по локальной БД — для очень больших историй стоит заменить на поле `lastMessage` в документе диалога.

## Offline-First

- Сообщения и диалоги сначала пишутся в RxDB, интерфейс читает только из неё.
- Диалог можно открыть без сети: он получает временный id `L<peerId>` и создаётся на сервере при появлении связи, после чего сообщения переезжают на серверный id.
- Начальная REST-синхронизация не зависит от SignalR; хаб нужен только для отправки и событий реального времени.
- Локальная БД называется `messenger2-<userId>`; старую `messenger-…` можно удалить в DevTools → Application → IndexedDB.
