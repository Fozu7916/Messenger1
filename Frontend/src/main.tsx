import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './components/ui';
import './styles.css';
import { applyTheme } from './lib/theme';

applyTheme();

// StrictMode не используется намеренно: двойной монтаж эффекта создавал бы два подключения SignalR/RxDB.
createRoot(document.getElementById('root')!).render(
  <AuthProvider><ToastProvider><App /></ToastProvider></AuthProvider>,
);
