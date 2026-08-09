# AI Trip Planner

Pierwszy fundament produktu planującego podróże w modelu deterministic-first: kod odpowiada za ograniczenia i koszty, a przyszła warstwa AI za miękkie dopasowanie i generowanie.

## Uruchomienie

Wymagany jest Node.js 24 i npm 11.

```sh
npm ci
npm run dev
```

Backend CAP działa na `http://localhost:4004` (`/health`), a frontend Vite na `http://localhost:5173`.

## Weryfikacja

```sh
npm run verify
npx playwright install chromium
npm run verify:full
```

Szczegóły architektury i zakresu znajdują się w katalogu `docs/`.
