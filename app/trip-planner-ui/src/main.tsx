import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@ui5/webcomponents/dist/Assets.js';
import App from './App.js';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Nie znaleziono elementu głównego aplikacji.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
