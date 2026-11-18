// Окружение для интеграционных тестов: IndexedDB в памяти (под RxDB/Dexie) и Web Crypto (RxDB считает хеши).
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
