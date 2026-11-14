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
  editedAt: string | null;
  replyToId: string | null;          // ответ на сообщение этого же диалога
  forwardedFromId: string | null;    // автор оригинала, если сообщение переслано
  forwardedFromName: string | null;  // его имя на момент пересылки
}

interface Profile {                  // GET/PUT /api/users/me, GET /api/users/{id}
  id: string;
  login: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
  isOnline?: boolean | null;         // только для собеседников (есть общий диалог), иначе null
  lastSeenAt?: string | null;        // то же; заполнено, если isOnline = false
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
POST /api/auth/logout        → 204
```

Выход stateless: клиент просто удаляет токен и закрывает соединение хаба.

### Профиль и поиск

```http
GET  /api/users/me           → Profile
PUT  /api/users/me           { "displayName": "Alice A.", "avatarUrl": "https://example.com/a.png", "bio": "О себе" }   → Profile
GET  /api/users/{id}         → Profile   (чужой профиль; 404, если нет такого пользователя)
POST /api/auth/password      { "currentPassword": "...", "newPassword": "..." }   → 204
```

- `avatarUrl` — только публичный `https` или `null` (пусто — убрать аватар).
- `bio` — до 300 символов. **`null`/поле не передано — не менять**, `""` — очистить. Старые клиенты, не знающие про `bio`, ничего не теряют.
- `isOnline`/`lastSeenAt` в чужом профиле видны только тем, у кого с этим человеком есть общий диалог.
- Смена пароля: неверный текущий — `400` (не `401`, чтобы клиент не разлогинил пользователя), все **остальные** сессии отзываются, текущая остаётся. Повторные ошибки блокируются так же, как при входе (`429` + `Retry-After`).

### Поиск людей и поиск сообщений — это разные запросы

```http
GET /api/users/search?q=пет ив&scope=all&limit=20&offset=0   → User[]
GET /api/messages/search?q=молоко хлеб&dialogId=...&before=...   → Message[]
GET /api/users?query=bo      → User[]   (список «Люди»: без query — все по алфавиту; с query — как /search)
```

Поиск **по частям**: запрос делится на слова (до 5), каждое должно встретиться, в любом порядке и в любом месте, без учёта регистра; `%` и `_` — обычные символы.

- `/api/users/search`: слова ищутся в логине и имени, ведущий `@` игнорируется. Сначала те, у кого логин/имя **начинается** с первого слова. `scope=all` (по умолчанию) — все люди, `q` обязателен; `scope=contacts` — только те, с кем уже есть диалог (`q` можно опустить). Себя в выдаче нет. `limit` 1–100, по умолчанию 20.
- `/api/messages/search`: слова ищутся в тексте сообщений во всех своих диалогах или в одном (`dialogId`). Минимум 2 символа, от новых к старым, следующая страница — `before=<id последнего>`. `limit` 1–50, по умолчанию 30. Удалённые и скрытые у вас сообщения не находятся.

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

### Редактирование и удаление сообщения

```http
PUT    /api/messages/{id}              { "text": "..." }   → Message   (только своё; 1–4000 символов)
DELETE /api/messages/{id}?scope=all    → 204   (по умолчанию: у обоих)
DELETE /api/messages/{id}?scope=me     → 204   (скрыть только у себя)
```

Удалять может любой участник диалога (как в Telegram). Чужое или несуществующее — `404`. Событие: `MessageEdited` / `MessageDeleted`. Удаление у обоих заодно открепляет сообщение.

### Закреплённые сообщения

```http
GET    /api/dialogs/{dialogId}/pins               → Message[]   (сначала закреплённые позже)
PUT    /api/dialogs/{dialogId}/pins/{messageId}   → 204   (повтор — no-op; максимум 10 на диалог, иначе 409)
DELETE /api/dialogs/{dialogId}/pins/{messageId}   → 204
```

Закреп общий для обоих участников, закрепить может любой из них. Не участник диалога — `404`. События: `MessagePinned`, `MessageUnpinned`.

### Пересылка

```http
POST /api/dialogs/{dialogId}/forward
{ "toDialogId": "...", "messageIds": ["..."], "clientBatchId": "uuid" }   → Message[]
```

До 50 сообщений из `dialogId` в `toDialogId`; оба диалога должны быть вашими, иначе `404`. Копии получают `forwardedFromId`/`forwardedFromName` исходного автора (при повторной пересылке остаётся первый автор) и порядок оригинала. `clientBatchId` (до 40 символов) делает запрос идемпотентным: повтор вернёт те же сообщения и не создаст копий. Получатели видят обычное `MessageReceived`.

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
| `SendReply` | `clientMessageId`, `dialogId`, `text`, `replyToId: string` | `string` — серверный ULID | Отправить ответ на сообщение этого же диалога |
| `Typing` | `dialogId: string` | — | Сообщить, что пользователь печатает |

Ограничения `SendMessage` и `SendReply`: `clientMessageId` — до 64 символов (удобно `crypto.randomUUID()`), `text` — 1–4000 символов после обрезки пробелов.

```ts
const serverUlid = await connection.invoke<string>(
  "SendMessage", clientMessageId, dialogId, text
);
```

`Typing` сервер пропускает не чаще раза в секунду (лишние вызовы молча игнорируются).

### События сервер → клиент

| Событие | Аргументы | Кому приходит |
|---------|-----------|---------------|
| `MessageReceived` | `Message` | Всем участникам диалога, **включая отправителя** (его другие вкладки и устройства) |
| `MessageAcked` | `clientMessageId`, `serverUlid` | Только соединению, которое отправило сообщение |
| `MessageDeleted` | `dialogId`, `messageId` | Всем участникам диалога (при `scope=me` — только вашим устройствам) |
| `MessageEdited` | `Message` | Всем участникам диалога |
| `MessagePinned` | `dialogId`, `Message`, `pinnedById` | Всем участникам диалога |
| `MessageUnpinned` | `dialogId`, `messageId` | Всем участникам диалога |
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
| `invalid_reply_to` | `replyToId` не ULID, не из этого диалога или сообщение удалено |
| `rate_limited` | Слишком частые вызовы (`SendMessage`/`SendReply` — 20 за 10 с) |

Соединение закрывается сервером, когда истекает access-токен, с которым оно открыто; клиент переподключается с актуальным токеном (`accessTokenFactory`).
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

## Файлы: аватар, обои, оформление

Файлы лежат в S3 (см. раздел «Файловое хранилище» в DOCUMENTATION.md). Без настроенного хранилища все файловые эндпоинты отвечают `503`.

```http
POST   /api/users/me/avatar            multipart, поле file (JPEG/PNG/WebP/GIF, до 5 МБ)   → Profile
DELETE /api/users/me/avatar                                                               → Profile
GET    /api/files/avatars/{userId}/{name}.webp     (без токена, кэш на год)                → image/webp

GET    /api/users/me/wallpapers                                                          → [{ "id": "..." }]  (новые первыми)
POST   /api/users/me/wallpapers        multipart, поле file, до 12 штук                   → 201 { "id": "..." }
GET    /api/users/me/wallpapers/{id}   (только владельцу, по токену)                      → image/webp
DELETE /api/users/me/wallpapers/{id}                                                      → 204

GET    /api/users/me/appearance                                                          → JSON-объект ({} если пусто)
PUT    /api/users/me/appearance        JSON-объект до 4 КБ, формат определяет клиент      → 204
```

- Любая загруженная картинка декодируется, поворачивается по EXIF и перекодируется в WebP (метаданные, включая геолокацию, удаляются). Аватар: квадрат по центру до 512×512; обои: до 1920 px по большей стороне. Не картинка или повреждённый файл, а также слишком большое разрешение — `400`; лимит обоев — `409`.
- `Profile.avatarUrl` у загруженной аватарки — относительный путь `/api/files/avatars/...`; клиент дописывает адрес API. `PUT /api/users/me` с тем же `avatarUrl` оставляет аватар как есть, внешние ссылки (https) по-прежнему допустимы.
- Обои приватны: `<img>` не умеет слать токен, поэтому клиент берёт их через `fetch`, кэширует в Cache Storage и показывает blob-ссылкой.

## Беседы

Беседа — диалог с типом `group`: название, аватар, до 50 участников. В `DialogDto` у беседы `kind = "group"`, `title`, `memberCount`, `myRole` (`owner` | `member`); «собеседник» (`peer`) синтетический: `id` = id беседы, `displayName` = название, `avatarUrl` = аватар беседы, поэтому клиент без особых случаев показывает название и фото. `peerLastReadId` у бесед всегда `null` («прочитано» не показывается).

```http
POST   /api/dialogs/group                       { "title": "Дача", "memberIds": ["..."] }  → 201 DialogDto   (1–49 других участников)
GET    /api/dialogs/{id}/members                                                          → [{ "user": User, "role": "owner" | "member" }]
PUT    /api/dialogs/{id}                        { "title": "Новое" }                      → 204   (только владелец)
POST   /api/dialogs/{id}/members                { "userIds": ["..."] }                    → [Member]   (любой участник; всего ≤ 50)
DELETE /api/dialogs/{id}/members/{userId}       userId = "me" — выйти; чужой — исключить  → 204   (исключать может владелец)
POST   /api/dialogs/{id}/avatar                 multipart, поле file                      → 204   (любой участник)
DELETE /api/dialogs/{id}/avatar                                                           → 204
DELETE /api/dialogs/{id}                        беседу удаляет только владелец             → 204   (остальные выходят)
GET    /api/files/group-avatars/{dialogId}/{name}.webp   (без токена, кэш на год)
```

- Если владелец вышел, роль получает самый ранний участник; если вышел последний — беседа удаляется вместе с вложениями.
- О создании, переименовании, добавлении, выходе и исключении в беседу пишется **служебное сообщение** (`kind = "system"`, автор — тот, кто сделал действие). В непрочитанные оно не считается, пересылать его нельзя.
- Событие хаба **`DialogsChanged`** (без параметров) приходит всем затронутым (в том числе исключённому и удалённой беседе): клиент перезагружает список диалогов.
- Личный диалог (`POST /api/dialogs`) всегда создаётся как `direct`, даже если у пары есть общая беседа.

## Фото и голосовые сообщения

```http
POST /api/dialogs/{dialogId}/messages/media     multipart/form-data → Message
     file              — картинка (JPEG/PNG/WebP/GIF, до 10 МБ) или голосовое (до 3 МБ)
     clientMessageId   — ключ идемпотентности (как у SendMessage)
     kind              — "image" | "voice"
     text              — подпись, до 1000 символов (необязательно)
     durationMs        — длительность голосового (необязательно, ограничивается 0–10 минут)
     replyToId         — ответ на сообщение этого диалога (необязательно)
GET  /api/dialogs/{dialogId}/media/{ulid}.{webp|ogg|webm|m4a|mp3}    → файл (только участникам диалога, по токену)
```

- В `Message` появились поля `kind` (`text` | `image` | `voice` | `system`), `mediaUrl` (путь выше), `mediaWidth`, `mediaHeight` (фото), `mediaDurationMs` (голосовое). У вложений `text` — подпись (может быть пустой).
- Фото декодируется и перекодируется в WebP до 1600 px (метаданные удаляются). Голосовое проверяется по первым байтам (webm — Chrome/Edge, ogg — Firefox, m4a — Safari, mp3); расширению и Content-Type клиента сервер не верит.
- Файлы приватны: `<img>`/`<audio>` не умеют слать токен, поэтому клиент берёт их через `fetch`, кэширует в Cache Storage и показывает blob-ссылкой.
- Удаление сообщения «у обоих» удаляет и файл. Пересылка вложения создаёт копию файла в целевом диалоге (удаление оригинала копию не ломает). Удаление диалога/беседы удаляет все его вложения.
- Ответ — `201/200 Message`; повтор с тем же `clientMessageId` вернёт то же сообщение и не создаст второго файла. Участникам уходит `MessageReceived`. Хранилище не настроено — `503`.
