# AI Trip Planner

Deterministic-first planner krótkich podróży. Kod waliduje twarde ograniczenia, pobiera
wersjonowane dane demonstracyjne, buduje i filtruje kandydatów, liczy budżet oraz scoring,
a następnie pokazuje dokładnie trzy zróżnicowane warianty wraz ze źródłami i odrzuceniami.

Faza 2 — Planning API and Options UI — jest ukończona. Projekt nie używa jeszcze LLM,
zewnętrznych providerów, rezerwacji, płatności ani uwierzytelniania.

## Uruchomienie

Wymagane są Node.js 24 i npm 11.

```sh
npm ci
npm run dev
```

Backend CAP działa na `http://localhost:4004` (`/health`), a frontend Vite na
`http://localhost:5173`.

## Scenariusz referencyjny

1. Otwórz `http://localhost:5173`.
2. Wpisz miasto `Wrocław`, daty `2026-10-10`–`2026-10-13`, 2 osoby i budżet 4500 PLN.
3. Wybierz tempo spokojne.
4. Ustaw: wyjazd od 07:00, powrót do 22:00, maks. 1 przesiadkę i 480 minut na odcinek.
5. Wyłącz samolot, pozostaw pociąg i autobus, a budżet jako twardy limit.
6. Ustaw preferencje: jedzenie 5, natura 5, historia 3, muzea 2, życie nocne 1,
   centralny nocleg 4, komfort 4, cena 4.
7. Zapisz brief, sprawdź oba podsumowania i potwierdź ograniczenia.
8. Kliknij „Znajdź warianty”. Powinny pojawić się dokładnie trzy karty:
   Praga (`BEST_OVERALL`), Wiedeń (`MOST_CONVENIENT`) i Budapeszt (`BEST_VALUE`).
9. Rozwiń budżet, źródła i diagnostykę 22 odrzuconych kandydatów.

Każde źródło `INTERNAL_FIXTURE` jest w UI jawnie oznaczone jako dane demonstracyjne,
nie jako aktualna oferta.

## API

Serwis OData V4 jest dostępny pod `/trip-planner`:

- CRUD szkicu: `TripRequests`;
- akcje bound: `confirmConstraints`, `startPlanning`;
- odczyt: `WorkflowRuns`, `PlanningRuns`, `WorkflowTransitions`, `RankedOptions`,
  `BudgetBreakdowns`, `BudgetItems`, `SourceSnapshots`, `OptionNotes`,
  `RejectionReasons`, `RejectionSummaries`.

Kontrolowany niedobór trzech opcji zwraca trwały `PlanningRun` ze statusem
`INSUFFICIENT_OPTIONS`, kodem błędu i diagnostyką, ale bez częściowych `RankedOptions`.

## Weryfikacja

```sh
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
npm run verify
npx playwright install chromium
npm run verify:full
```

Testy i scenariusz referencyjny nie używają internetu ani bieżącej daty. Szczegóły
architektury, zakresu i znanych ograniczeń znajdują się w `docs/`.
