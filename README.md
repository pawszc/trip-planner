# AI Trip Planner

Deterministic-first planner krótkich podróży. Kod waliduje twarde ograniczenia, pobiera
wersjonowane dane demonstracyjne, buduje i filtruje kandydatów, liczy budżet oraz scoring,
a następnie pokazuje dokładnie trzy zróżnicowane warianty wraz ze źródłami i odrzuceniami.

Faza 2 — Planning API and Options UI — jest ukończona. Faza 3B1 dodaje domyślnie
wyłączone, task-aware profile wykonania oraz trwały audyt `AiRuns`. Faza 3B2 wykorzystuje
ten fundament w pierwszej jawnej akcji grounded narrative dla jednej wybranej opcji.
Standardowe uruchomienie i testy nie wywołują płatnych API. Projekt nadal nie obsługuje
rezerwacji, płatności ani uwierzytelniania.

## Uruchomienie

Wymagane są Node.js 24 i npm 11.

```sh
npm ci
npm run dev
```

Backend CAP działa na `http://localhost:4004` (`/health`), a frontend Vite na
`http://localhost:5173`.

Do standardowego uruchomienia nie są potrzebne klucze OpenAI ani Anthropic. Konfigurację
gatewaya ładuje się jawnie dopiero w miejscu użycia; import, build i start aplikacji nie
odczytują ani nie wymagają sekretów.

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

## AI execution i grounded narratives Fazy 3B2

Gateway udostępnia jeden kontrakt strukturalnych wywołań i osobny profil
`provider + model + effort + max output tokens` dla `DECIDE`, `GENERATE` i `JUDGE`.
Domyślnie są to OpenAI Luna (`DECIDE`), Anthropic Sonnet (`GENERATE`) i OpenAI Terra
(`JUDGE`). Request produktu nie ma provider override; opcjonalny limit może tylko obniżyć
limit profilu. Zmiana providera wymaga jawnego modelu. Nazwy modeli są jawne i nigdy nie są
cicho zmieniane.

Adaptery otrzymują profil per call i rozróżniają `configuredModel` od `responseModel`.
Każde wykonanie ma UUID i asynchroniczny lifecycle `STARTED` → `SUCCEEDED`/`FAILED`.
Recorder jest fail-closed: brak trwałego `STARTED` blokuje provider, a brak trwałego
`SUCCEEDED` blokuje zwrot outputu.

`AiGateway` wymaga jawnego recordera, a persistent factory składa realny recorder i store.
Na SQLite gateway działa poza aktywną transakcją DB: krótki odczyt kończy się przed AI, a
krótki zapis produktu zaczyna dopiero po terminalnym audycie. Próba z aktywnej transakcji
jest odrzucana przed adapterem, zamiast wejść w circular wait.

Bound action `RankedOptions.generateNarrative()` buduje `grounded-option-context-v1` z
udanej opcji, jej kategorii budżetu i źródeł. Każdy fakt — także jawny `UNKNOWN` albo
`MISSING` — ma deterministyczny identyfikator związany z dokładnym fingerprintem kontekstu.
Transport i nocleg wskazują rozwiązywalne `SourceSnapshot`, a code-derived score, selection
i agregaty budżetu mają jawne wersje `INTERNAL_DETERMINISTIC`. Kod przygotowuje też display
kwot z minor units. Zamknięty `currency-fraction-digits-v1` współdzielony przez walidację,
major → minor i display dopuszcza obecnie PLN/EUR z dwiema cyframi; JPY, KWD i nieznane kody
są odrzucane. Kategorie budżetu, klasyfikacje, sumy i status agregatu są walidowane
fail-closed, podobnie jak lineage wersji fixture/scoringu na wszystkich rekordach opcji.
Model nie dzieli ani nie formatuje pieniędzy.
Strict output wymaga exact context fingerprint i niepustych `factReferences` każdego bloku;
nieznany, pusty, nieaktualny albo obcy identyfikator odrzuca cały output przed persistence.

Po trwałym `SUCCEEDED` writer sprawdza exact plan/task/prompt/schema/input fingerprint, a
osobna transakcja zapisuje `NarrativeRuns`, `OptionNarratives` i
`NarrativeFactReferences`. Produkt zachowuje historyczny scalar `aiRunId`, nie mandatory
association do audytu. Błąd AI, audytu, walidacji lub tego zapisu nie zmienia
deterministycznej opcji, rankingu, constraints ani budżetu.
Akcja nie jest automatycznie wywoływana przez `startPlanning` ani obecne UI.

Wewnętrzne `AiRuns` nie jest publikowane przez OData. Przechowuje wyłącznie bezpieczne
metadane i domyślny `expiresAt` po 30 dniach — bez promptów, wejść, wyjść i surowych błędów.
Jest efemerycznym audytem: cleanup nie narusza trwałych narracji produktu. Kontrakt cleanup
jest zaimplementowany i przetestowany, ale nie ma jeszcze schedulera.

`AI_ENABLED=false` wyłącza gateway dla produktu, a `AI_LIVE_SMOKE_ENABLED=false` blokuje
ręczne testy live. Przed włączeniem produktu trzeba zatwierdzić retencję organizacji
providera, ZDR, politykę prywatności i dozwolony zakres danych. Testy używają transportów i
adapterów in-memory, więc nie kontaktują się z internetem. Po świadomym skonfigurowaniu
sekretów poza repo dostępne są:

```sh
npm run ai:credentials:check
npm run ai:smoke:openai
npm run ai:smoke:anthropic
npm run ai:smoke
```

Smoke test jest osobnym, płatnym wywołaniem opt-in i nie należy do `verify` ani
`verify:full`. Nigdy nie commituj `.env` ani kluczy. Pełny kontrakt, konfiguracja,
bezpieczeństwo i ograniczenia są opisane w `docs/ai-gateway.md`.

Poprawna referencja zapewnia traceability, ale nie jest jeszcze semantycznym dowodem
groundedness. Faza 3B3 doda wykonywanie judge, safety pipeline i evale.

## API

Serwis OData V4 jest dostępny pod `/trip-planner`:

- CRUD szkicu: `TripRequests`;
- akcje bound: `confirmConstraints`, `startPlanning` oraz jawne
  `RankedOptions.generateNarrative`;
- odczyt: `WorkflowRuns`, `PlanningRuns`, `WorkflowTransitions`, `RankedOptions`,
  `BudgetBreakdowns`, `BudgetItems`, `SourceSnapshots`, `OptionNotes`,
  `RejectionReasons`, `RejectionSummaries`, `NarrativeRuns`, `OptionNarratives` i
  `NarrativeFactReferences`.

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
