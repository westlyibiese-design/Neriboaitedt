import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { installGlobalDiagnostics } from './lib/diagnostics.ts';
import { registerServiceWorker } from './lib/push.ts';
import './index.css';

// System Console Diagnostics (Phase 3): installs the window.onerror /
// unhandledrejection listeners and the functions/api/* fetch capture,
// exactly once, before anything renders — see src/lib/diagnostics.ts.
installGlobalDiagnostics();

// Push notifications (see PUSH_NOTIFICATIONS_IMPLEMENTATION_SPEC.md §3.1):
// register the FCM service worker once, early, before sign-in even
// resolves — registration itself doesn't need an account. The actual
// permission prompt + token registration (src/lib/push.ts's initPush)
// only happens later, once a signed-in uid is known (see src/App.tsx).
// Feature-detects internally and never throws.
void registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);
