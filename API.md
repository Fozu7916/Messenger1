# API: контракт для фронтенда

Базовый адрес в разработке: `http://localhost:5080`. Интерактивная документация REST: `http://localhost:5080/swagger`.
Полное описание архитектуры — в [DOCUMENTATION.md](../DOCUMENTATION.md), раздел 5.

## Общие правила

- Формат — JSON, имена полей в `camelCase`. Время (`createdAt`) — ISO 8601 в UTC, например `2026-10-18T14:13:05.123Z`.
- Все идентификаторы — ULID (строка из 26 символов). Сортировка ULID как строк совпадает с хронологической.
- Защищённые эндпоинты требуют заголовок `Authorization: Bearer <accessToken>`.
- Ошибки приходят в формате `application/problem+json`:

```json
{ "type": "...", "title": "Login or email is already taken", "status": 409 }
```

| Код | Когда |
|-----|-------|
| `400` | Невалидные данные (для ошибок валидации в ответе есть поле `errors` по полям) |
| `401` | Нет токена, токен просрочен или неверный логин/пароль |
| `404` | Не найдено **или нет доступа** (чужой диалог выглядит как несуществующий) |
| `409` | Логин или email уже заняты |
| `429` | Слишком много запросов на `/api/auth/*` (по умолчанию 10 в минуту с одного IP) |

- CORS: разрешён origin `http://localhost:5173` (меняется в конфигурации бэкенда).
- Токен живёт 60 минут, refresh-токенов пока нет: при `401` отправляйте пользователя на вход.

## Типы

```ts
interface User {
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
}

interface Message {
  id: string;               // серверный ULID
  clientMessageId: string;  // ключ, который сгенерировал клиент
  dialogId: string;
  senderId: string;
  text: string;
  mediaUrl: string | null;
  createdAt: string;
}

interface Dialog {
  id: string;
  createdAt: string;
  peer: User | null;
  lastMessage: Message | null;
}

interface AuthResponse {
  accessToken: string;
  expiresAt: string;
  user: User;
}
```

## REST

### Аутентификация

```http
POST /api/auth/register
{ "login": "alice", "email": "alice@example.com", "password": "Passw0rd!x", "displayName": "Alice" }
```

Ограничения: `login` — 3–32 символа, латиница, цифры и `_`; `password` — 8–72 символа; `displayName` — до 64 символов. Ответ `200` — `AuthResponse`.

```http
POST /api/auth/login
{ "login": "alice", "password": "Passw0rd!x" }
```

В `login` можно передать логин или email. Ответ `200` — `AuthResponse`, неверные данные — `401`.

```http
POST /api/auth/refresh       → 200 AuthResponse
POST /api/auth/logout        → 204
```

`refresh` по ещё действующему токену выдаёт новый — клиент вызывает его заранее, до истечения, поэтому активная сессия не обрывается.
Выход stateless: клиент удаляет токен, закрывает соединение хаба и стирает локальную копию переписки.

### Профиль и поиск

```http
GET  /api/users/me           → User
PUT  /api/users/me           { "displayName": "Alice A.", "avatarUrl": "https://example.com/a.png" }   → User
GET  /api/users?query=bo     → User[]
```

`avatarUrl` — только `http`/`https` или `null`. Поиск — по префиксу логина или имени, от 2 символов, не больше 20 результатов, себя в выдаче нет.

### Диалоги

```http
GET    /api/dialogs                 → Dialog[]   (отсортированы: сначала с самым свежим сообщением)
POST   /api/dialogs   { "userId": "<ULID собеседника>" }   → 201 Dialog (новый) или 200 Dialog (уже был)
DELETE /api/dialogs/{id}            → 204
```

Удаление диалога сносит его у обоих участников вместе с сообщениями. Диалог с самим собой — `400`.

### История и дельта

```http
GET /api/dialogs/{dialogId}/messages?limit=50
GET /api/dialogs/{dialogId}/messages?before={ULID}&limit=50
GET /api/dialogs/{dialogId}/messages?after={ULID}&limit=100
```

Ответ — `Message[]`, **всегда по возрастанию ULID**, удалённые сообщения не возвращаются.

| Параметр | Что делает |
|----------|------------|
| (нет) | Последние `limit` сообщений: первая загрузка диалога |
| `before` | Сообщения старше указанного: подгрузка вверх при прокрутке |
| `after` | Сообщения новее указанного: синхронизация после офлайна (`LastSyncULID`) |
| `limit` | 1–100, по умолчанию 50 |

`after` и `before` одновременно — `400`. Если в `after` пришла полная страница (`limit` штук), запрашивайте дальше, пока не вернётся меньше `limit`.

### Удаление сообщения

```http
DELETE /api/messages/{id}    → 204
```

Только своё сообщение; чужое или несуществующее — `404`. Остальным участникам уходит событие `MessageDeleted`.

## SignalR Hub

Адрес: `/hubs/chat`. Нужен пакет `@microsoft/signalr`.

```ts
import { HubConnectionBuilder, HubConnectionState } from "@microsoft/signalr";

const connection = new HubConnectionBuilder()
  .withUrl(`${API_URL}/hubs/chat`, { accessTokenFactory: () => getToken() })
  .withAutomaticReconnect()
  .build();

// ВАЖНО: обработчики регистрируются до start()
connection.on("MessageReceived", (m: Message) => { /* см. «Входящие сообщения» */ });
connection.on("MessageAcked", (clientMessageId: string, serverUlid: string) => { /* pending → sent */ });
connection.on("MessageDeleted", (dialogId: string, messageId: string) => { /* убрать из UI/RxDB */ });
connection.on("UserTyping", (dialogId: string, userId: string) => { /* показать «печатает…» на ~3 с */ });
connection.on("PresenceChanged", (userId: string, status: "online" | "offline") => { /* обновить статус */ });

connection.onreconnected(() => syncAfterReconnect());

await connection.start();
```

Токен передаётся автоматически: для WebSocket — в query-параметре `access_token`, для остальных транспортов — в заголовке.
Без валидного токена подключение отклоняется.

### Методы клиент → сервер

| Метод | Аргументы | Возвращает | Назначение |
|-------|-----------|------------|------------|
| `SendMessage` | `clientMessageId: string`, `dialogId: string`, `text: string` | `string` — серверный ULID | Отправить сообщение |
| `Typing` | `dialogId: string` | — | Сообщить, что пользователь печатает |

Ограничения `SendMessage`: `clientMessageId` — до 64 символов (удобно `crypto.randomUUID()`), `text` — 1–4000 символов после обрезки пробелов.

```ts
const serverUlid = await connection.invoke<string>(
  "SendMessage", clientMessageId, dialogId, text
);
```

`Typing` не чаще раза в 2–3 секунды: ограничения на стороне сервера пока нет.

### События сервер → клиент

| Событие | Аргументы | Кому приходит |
|---------|-----------|---------------|
| `MessageReceived` | `Message` | Всем участникам диалога, **включая отправителя** (его другие вкладки и устройства) |
| `MessageAcked` | `clientMessageId`, `serverUlid` | Только соединению, которое отправило сообщение |
| `MessageDeleted` | `dialogId`, `messageId` | Всем участникам диалога |
| `DialogDeleted` | `dialogId` | Всем участникам удалённого диалога |
| `UserTyping` | `dialogId`, `userId` | Остальным участникам диалога |
| `PresenceChanged` | `userId`, `status` | Тем, с кем у пользователя есть диалоги |

`PresenceChanged` сообщает только об изменениях. Текущий статус собеседников при подключении сервер пока не присылает.

### Ошибки хаба

`invoke` отклоняется ошибкой, в тексте которой есть код:

| Код | Причина |
|-----|---------|
| `forbidden` | Пользователь не состоит в диалоге (или диалога нет) |
| `invalid_text` | Пустой текст или длиннее 4000 символов |
| `invalid_client_message_id` | Пустой или длиннее 64 символов |
| `unauthorized` | Нет идентификатора пользователя в токене |

## Сценарии

### Отправка сообщения (Optimistic UI)

1. Сгенерировать `clientMessageId` и записать сообщение в RxDB со статусом `pending`.
2. Вызвать `SendMessage`.
3. По `MessageAcked` (или по результату `invoke`) записать `serverUlid` и статус `sent`.
4. Если `invoke` упал из-за обрыва соединения, сообщение остаётся `pending`: его отправят повторно после переподключения. Если упал с `forbidden` или `invalid_*` — это `failed`, повторять не нужно.

### Входящие сообщения и дубликаты

`MessageReceived` приходит и отправителю, поэтому перед вставкой проверяйте локальную БД по `clientMessageId`:

```ts
const existing = await db.messages.findOne({ selector: { clientMessageId: m.clientMessageId } }).exec();
if (existing) {
  await existing.patch({ id: m.id, status: "sent", createdAt: m.createdAt }); // подтверждаем свою копию
} else {
  await db.messages.insert({ ...m, status: "sent" });
}
```

Совет: в RxDB используйте `clientMessageId` как первичный ключ локального сообщения, а серверный `id` храните отдельным полем. Тогда сообщение можно сохранить до того, как сервер присвоил ULID.

### Возвращение из офлайна

Выполняйте при `onreconnected` и при первом подключении после загрузки страницы:

1. Для каждого диалога взять `LastSyncULID` — максимальный серверный `id` среди локальных сообщений со статусом `sent`.
2. Запросить `GET /api/dialogs/{id}/messages?after={LastSyncULID}&limit=100` и повторять, пока приходит полная страница.
3. Слить результат в локальную БД с проверкой по `clientMessageId`, как выше.
4. Повторно отправить все сообщения со статусом `pending`: повтор безопасен, при том же `clientMessageId` сервер вернёт уже сохранённое сообщение и не создаст дубль, а `MessageReceived` собеседнику повторно не уйдёт.
5. Обновить список диалогов: `GET /api/dialogs`.

Ограничение: удаления, случившиеся пока клиент был офлайн, через `after` не приходят. Их можно подхватить, перезагрузив последние сообщения открытого диалога.

### Открытие диалога и прокрутка

1. Показать локальные сообщения из RxDB и сразу запросить `GET .../messages?limit=50`.
2. При прокрутке вверх запрашивать `before={id самого старого локального сообщения}`.
3. Если вернулось меньше `limit`, более старых сообщений нет.

### Создание диалога

1. `GET /api/users?query=...`, пользователь выбирает собеседника.
2. `POST /api/dialogs` с его `id`. Повторный вызов с тем же собеседником безопасен: вернётся существующий диалог.

### Сохранение состояния при обновлении страницы

Храните `accessToken`, `expiresAt`, id открытого диалога и позицию прокрутки. При старте проверьте `expiresAt`, затем `GET /api/users/me`: ответ `401` означает, что нужен повторный вход. Токен в `localStorage` доступен скриптам страницы, поэтому особенно важно экранировать пользовательский текст при выводе (защита от XSS).