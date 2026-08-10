import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Artefakty instalacji, kompilacji i testów nie są kodem źródłowym do analizy.
    ignores: [
      '**/node_modules/**',
      '**/gen/**',
      '**/@cds-models/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        document: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      // Importy typów są jawne, a `any` nie może omijać ścisłego modelu TypeScript.
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Reguły React dotyczą wyłącznie aplikacji przeglądarkowej, nie backendu CAP.
    files: ['app/trip-planner-ui/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      ...reactRefresh.configs.vite.rules,
    },
  },
);
