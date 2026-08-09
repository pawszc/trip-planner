# Architektura

Backend wykorzystuje SAP CAP 10, TypeScript ESM i lokalny adapter SQLite. Frontend jest osobnym workspace React/Vite z UI5 Web Components for React. Vite przekazuje `/trip-planner` i `/health` do CAP.

Warstwy backendu:

- `domain/` — typy i dozwolone przejścia stanu;
- `validation/` — czysta, testowalna walidacja twardych ograniczeń;
- `orchestration/` — przyszła koordynacja przepływu;
- `providers/` — przyszłe adaptery usług zewnętrznych;
- `ranking/` — przyszłe filtrowanie i ranking wariantów;
- serwis CAP — transport OData, trwałość i kontrolowane błędy.

Kod jest jedynym źródłem prawdy dla constraints, wykonalności i kosztów. Przyszły LLM Gateway otrzyma wyłącznie jawne, ugruntowane dane oraz osobne funkcje decide/generate. Fakty providerów będą utrwalane jako `SourceSnapshot` przed wykorzystaniem przez model.

Wersje zostały dobrane dla Node.js 24: CAP 10 oficjalnie rekomenduje Node 24, przechodzi na ESM i Vitest, a Playwright wspiera bieżące linie Node 22/24/26. Używamy TypeScript 6, ponieważ jest najnowszą linią zgodną z zakresem peer dependency bieżącego `typescript-eslint`; TypeScript 7 został świadomie odrzucony zamiast omijania konfliktu. npm 11 zachowuje zgodność z lokalnym Node 24.13. Dokładne wersje są przypięte w `package.json` i `package-lock.json`.
