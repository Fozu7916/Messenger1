# Веб-мессенджер

Веб-сервис для приватного общения в реальном времени прямо в браузере, без установки отдельного приложения.

сейчас захощено через neon.com(postgres) и render(docker - front and back), так же есть файлы .env - можно разворачивать на локалхосте

рабочий CI/CD, деплой на render`е идёт только если GitHub Actions проходит

ссылка - [https://messenger1-g19r.onrender.com/](https://messenger1-g19r.onrender.com/)

## Возможности MVP

- Регистрация, авторизация и выход из аккаунта
- Восстановление пароля и подтверждение почты по ссылке из письма
- Управление профилем
- Поиск пользователей
- Личные диалоги и список диалогов
- Отправка и получение текстовых сообщений в реальном времени
- История переписки, удаление сообщений и диалогов
- Offline-First: сообщения не теряются при пропадании сети
- Загрузка медиафайлов напрямую в S3 (через Pre-signed URL)

## Технологии

| Слой | Стек |
|------|------|
| Frontend | React, TypeScript, RxDB (IndexedDB) |
| Backend | C# .NET 10, SignalR (WSS), REST API, EF Core + Dapper |
| Данные | PostgreSQL (ULID), S3 |

## Структура репозитория

```
Messenger1/
├── backend/
│   ├── Messenger.sln
│   ├── src/Messenger.Api/       # REST API + SignalR Hub
│   └── tests/Messenger.Tests/   # тесты бэкенда
├── frontend/                    # React + TS, тесты фронтенда
├── docker-compose.yml           # PostgreSQL, MinIO для разработки
├── .env.example
├── DOCUMENTATION.md             # документация
└── README.md
```

## Быстрый старт

### Требования

- .NET SDK 10
- Node.js 20+ и npm
- Docker (PostgreSQL, S3-совместимое хранилище MinIO)

### Запуск инфраструктуры

```bash
docker compose up -d
```

### Backend

```bash
cd backend
dotnet restore
dotnet run --project src/Messenger.Api
```

API слушает `http://localhost:5080`, Swagger — `http://localhost:5080/swagger`, SignalR Hub — `/hubs/chat`.
В режиме Development схема БД создаётся автоматически.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Тесты

```bash
# backend (интеграционным тестам нужен запущенный Docker)
cd backend && dotnet test

# frontend
cd frontend && npm test
```

## Конфигурация

Секреты (строка подключения к БД, ключи S3, JWT-секрет) хранятся в переменных окружения или `.env`, который **не коммитится** в репозиторий. Пример — в `.env.example`.

Имена переменных в формате ASP.NET Core, `__` означает вложенность:

| Переменная | Назначение |
|------------|------------|
| `ConnectionStrings__Postgres` | Строка подключения к PostgreSQL |
| `Jwt__Key` | Секрет подписи JWT, не короче 32 символов |
| `Cors__Origins__0` | Разрешённый origin фронтенда (прод: `https://messenger1-g19r.onrender.com`) |
| `App__PublicBaseUrl` | Адрес сайта для ссылок в письмах (прод: `https://messenger1-g19r.onrender.com`) |
| `Resend__ApiKey`, `Resend__From` | Отправка писем через Resend (HTTPS). `From` — адрес на подтверждённом домене, например `no-reply@fozu-dev.site` |
| `Smtp__Host`, `Smtp__Port`, `Smtp__User`, `Smtp__Password`, `Smtp__From` | Альтернатива: свой SMTP (порт 587). На бесплатном Render SMTP-порты закрыты |
| `Auth__RequireConfirmedEmail` | `true` — вход только с подтверждённой почтой (по умолчанию `false`) |

Если не задан ни `Resend__ApiKey`, ни `Smtp__Host`, в Development письма пишутся в лог, в Production не отправляются.

### Продакшен (Render)

Сайт: [https://messenger1-g19r.onrender.com](https://messenger1-g19r.onrender.com). Переменные задаются в разделе Environment сервиса на Render, не в репозитории. Письма уходят через Resend с домена `fozu-dev.site`; подробности и порядок настройки — в [DOCUMENTATION.md](DOCUMENTATION.md), раздел «Письма в продакшене».

## Документация

Подробное описание архитектуры, API, моделей данных, протоколов, безопасности, тестирования и статуса реализации — в [DOCUMENTATION.md](DOCUMENTATION.md).
