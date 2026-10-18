# Веб-мессенджер

Веб-сервис для приватного общения в реальном времени прямо в браузере, без установки отдельного приложения.

## Возможности MVP

- Регистрация, авторизация и выход из аккаунта
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
| Proxy | Nginx |
| Backend | C# .NET 10, SignalR (WSS), REST API, EF Core + Dapper |
| Данные | PostgreSQL (ULID, партиционирование), Redis (backplane, presence), S3 |

## Структура репозитория

```
Messenger1/
├── backend/
│   ├── Messenger.sln
│   ├── src/Messenger.Api/       # REST API + SignalR Hub
│   └── tests/Messenger.Tests/   # тесты бэкенда
├── frontend/                    # React + TS, тесты фронтенда
├── docker-compose.yml           # PostgreSQL, Redis, MinIO для разработки
├── .env.example
├── DOCUMENTATION.md             # документация
└── README.md
```

## Быстрый старт

### Требования

- .NET SDK 10
- Node.js 20+ и npm
- Docker (PostgreSQL, Redis, S3-совместимое хранилище MinIO)

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
| `ConnectionStrings__Redis` | Redis для backplane (необязательно) |
| `Jwt__Key` | Секрет подписи JWT, не короче 32 символов |
| `Cors__Origins__0` | Разрешённый origin фронтенда |

## Документация

Подробное описание архитектуры, API, моделей данных, протоколов, безопасности, тестирования и статуса реализации — в [DOCUMENTATION.md](DOCUMENTATION.md).
