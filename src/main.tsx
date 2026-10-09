import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary, installClientErrorLog } from './errorReporting.tsx';
// Fonts are part of the build: no request to Google on every start, and they work offline
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/fira-code/300.css';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/500.css';
import '@fontsource/fira-code/600.css';
import '@fontsource/fira-code/700.css';
import './index.css';

installClientErrorLog();
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
