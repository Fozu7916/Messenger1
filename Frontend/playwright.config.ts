import { defineConfig, devices } from '@playwright/test';

// E2E: настоящий браузер → Vite (5173, проксирует /api и /hubs) → бэкенд (5080) → PostgreSQL.
// Нужен запущенный PostgreSQL (локально: docker compose -f ../Infrastructure/docker-compose.yml up -d).
// Строку подключения можно переопределить: E2E_PG="Host=...;Port=5432;Database=...;Username=...;Password=..."
// Для тестов создаётся отдельная база messenger_e2e: EF сам создаёт её при первой миграции.
const PG = process.env.E2E_PG ?? 'Host=localhost;Port=5432;Database=messenger_e2e;Username=messenger;Password=messenger_dev_password';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,       // один бэкенд и одна база на все тесты; пользователи у каждого теста свои
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ru-RU',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // --no-launch-profile: настройки берём только из env ниже, а не из launchSettings.json
      command: 'dotnet run --project ../backend/src/Messenger.Api --no-launch-profile',
      url: 'http://localhost:5080/health',
      timeout: 180_000,       // первая сборка бэкенда
      reuseExistingServer: !process.env.CI,
      env: {
        ASPNETCORE_ENVIRONMENT: 'Development',
        ASPNETCORE_URLS: 'http://localhost:5080',
        ConnectionStrings__Postgres: PG,
        Jwt__Key: 'e2e-test-key-at-least-32-characters-long',
        Database__AutoMigrate: 'true',
        RateLimiting__AuthPerMinute: '1000',   // в тестах много входов с одного адреса
        Auth__RequireConfirmedEmail: 'false',
      },
    },
    {
      command: 'npm run dev -- --host localhost --strictPort',
      url: 'http://localhost:5173',
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
