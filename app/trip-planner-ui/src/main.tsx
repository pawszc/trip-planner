import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@ui5/webcomponents/dist/Assets.js';
import App from './App.js';
import './styles.css';

// Element `root` z index.html jest punktem montowania całej aplikacji React.
const root = document.getElementById('root');

if (!root) {
  throw new Error('Nie znaleziono elementu głównego aplikacji.');
}

// StrictMode pomaga wykrywać niebezpieczne efekty uboczne podczas pracy lokalnej.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
