import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary, OverlayProvider } from './components/ui';
import { LabProvider } from './state';
import { App } from './App';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <OverlayProvider>
        <LabProvider>
          <App />
        </LabProvider>
      </OverlayProvider>
    </ErrorBoundary>
  </StrictMode>
);
