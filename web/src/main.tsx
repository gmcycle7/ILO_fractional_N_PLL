import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './index.css';
import App from './App';
import { initTheme } from './lib/theme';

initTheme();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root element missing');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
