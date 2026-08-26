# AI Trip Planner

Deterministic-first planner krótkich podróży. Kod waliduje twarde ograniczenia, pobiera
wersjonowane dane demonstracyjne, buduje i filtruje kandydatów, liczy budżet oraz scoring,
a następnie pokazuje dokładnie trzy zróżnicowane warianty wraz ze źródłami i odrzuceniami.

Faza 2 — Planning API and Options UI — jest ukończona. Faza 3B1 dodała domyślnie
wyłączone, task-aware profile wykonania oraz trwały audyt `AiRuns`, a Faza 3B2 pierwszy
jawny use case grounded narrative dla wybranej opcji. Faza 3B3 jest w `REVIEW`: dodaje
model-safe projection, deterministyczny precheck, ścisły `JUDGE`, bezpieczne review
metadata i evale, zanim tekst stanie się danymi produktu. Standardowe uruchomienie i testy
nie wywołują płatnych API. Projekt nadal nie obsługuje rezerwacji, płatności ani
uwierzytelniania.

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

## AI execution i quality-gated narratives Fazy 3B3

Gateway udostępnia jeden kontrakt strukturalnych wywołań i osobny profil
`provider + model + effort + max output tokens` dla `DECIDE`, `GENERATE` i `JUDGE`.
Domyślnie są to OpenAI Luna (`DECIDE`), Anthropic Sonnet 5 (`GENERATE`) i OpenAI Luna
(`JUDGE`, `low`, 2048 wspólnych tokenów reasoning + visible output). Request produktu nie ma
provider override; opcjonalny limit może tylko obniżyć
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
Model nie dzieli ani nie formatuje pieniędzy. Do providera trafia deterministyczny
`narrative-model-view-v1`, który zachowuje wymagane fakty, `factId`, lineage i jawne braki,
ale usuwa między innymi raw `sourceUrl`, `externalItemId`, HTML, kontrolne znaki oraz zbędne
provider-shaped wartości. Klucze faktów provenance są na tej granicy zastępowane
wersjonowanymi, deterministycznymi opaque keys wyprowadzonymi wyłącznie z bezpiecznego
`factId`, nigdy z `provider`, `sourceKey`, `externalItemId`, `sourceUrl` ani `contexts`.
Pełny kontekst pozostaje lokalnym źródłem walidacji i lineage.

`GENERATE` otrzymuje fingerprintowany `narrative-generation-view-v1` z wyłącznie dozwolonymi
faktami `KNOWN` i zwraca provider transport `{blocks}` z najwyżej sześcioma blokami. Kod
waliduje niepuste `factReferences`, wstrzykuje exact context fingerprint i dokłada w stałej
kolejności wymagane provenance/freshness oraz `UNKNOWN`/`MISSING` disclosures; finalny output
ma najwyżej osiem bloków. Nieznany, pusty, nieaktualny albo obcy identyfikator odrzuca cały
output. Po finalizacji lokalny precheck blokuje URL-e, Markdown/HTML/script, kontrolne i bidi
znaki, wykluczone identyfikatory oraz mechanicznie niedozwolony reformat kwoty. Semantyczna
zmiana kwoty, nowe obliczenie lub wypełnienie `UNKNOWN` trafia do `JUDGE`, zgodnie z frozen
stage labels datasetu. Sędzia otrzymuje wersjonowany `narrative-quality-context-v2` i pełny,
strukturalny kontrakt `narrative-quality-rubric-v2` z exact version, canonical fingerprintem
oraz zamkniętym mapowaniem reason → dimension/severity, lecz zwraca wyłącznie zamknięte
findings. Kod wstrzykuje fingerprinty, wyprowadza dokładnie osiem statusów i publikuje tylko
przy ośmiu `PASS` oraz zerze findings. Runtime jest sprawdzany względem checked-in golden JSON.

Precheck lub semantyczny `REJECT` zapisuje w osobnej krótkiej transakcji wyłącznie bezpieczne
review metadata i nie zapisuje tekstu kandydata. `PUBLISH` atomowo utrwala review,
`NarrativeRuns`, `OptionNarratives` oraz `NarrativeFactReferences` dopiero po dokładnych
terminalnych audytach `SUCCEEDED` dla `GENERATE` i `JUDGE`. Produkt zachowuje historyczne
scalar IDs audytów bez mandatory associations blokujących cleanup. Błąd AI, audytu,
walidacji lub zapisu nie zmienia deterministycznej opcji, rankingu, constraints ani
budżetu. Akcja nie jest automatycznie wywoływana przez `startPlanning` ani obecne UI.

Próba `GENERATE` lub `JUDGE`, która nie osiągnęła durable `AiRuns.STARTED`, nie tworzy
`NarrativeReviewRun` i nie dostaje fikcyjnego UUID. Provider nie jest wywoływany, produkt
pozostaje pusty, a niezależny sink otrzymuje dokładnie jeden allowlistowany
`AI_PRE_START_FAILURE` bez promptu, inputu, candidate, raw błędu, stack trace ani `aiRunId`.

Wewnętrzne `AiRuns` nie jest publikowane przez OData. Przechowuje wyłącznie bezpieczne
metadane i domyślny `expiresAt` po 30 dniach — bez promptów, wejść, wyjść i surowych błędów.
Jest efemerycznym audytem: cleanup nie narusza trwałych narracji produktu. Kontrakt cleanup
jest zaimplementowany i przetestowany, ale nie ma jeszcze schedulera.

`AI_ENABLED=false` wyłącza gateway dla produktu, `AI_LIVE_SMOKE_ENABLED=false` blokuje
ręczne testy smoke, a `AI_LIVE_EVAL_ENABLED=false` blokuje finalny baseline. Przed
włączeniem produktu trzeba zatwierdzić retencję organizacji
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
`verify:full`. `npm run eval:offline` wykonuje deterministic contract replay: sprawdza
loader, resolvery, kontrakty, metryki, gates i bezpieczny report path, ale kopiuje frozen
expected labels do actual, więc jawnie raportuje `evidenceKind=CONTRACT_REPLAY` oraz
`modelQualityMeasured=false`. Standardowy `verify` uruchamia wcześniej
`npm run eval:schema:check`, który fail-closed porównuje runtime Zod z frozen JSON Schema.
Żaden z tych dowodów nie jest live baseline ani pomiarem jakości modelu.

Live E2E ma ponadto zamknięty katalog niezależnych executable `requiredProperties`.
Deterministyczne oracle sprawdzają dokładny candidate/context/model view/constraints bez
użycia decyzji, dimensions, findings ani reason codes tego samego `JUDGE`; all-`PASS` judge
nie może zamaskować naruszenia właściwości. Raportowany
`publicationBundleLinkageValidInMemory` oznacza wyłącznie konstrukcję bundle i exact lineage
w pamięci. Osobny test integracyjny na produkcyjnych writerach CAP i SQLite dowodzi realnego
zapisu, odczytu, atomowości oraz przetrwania cleanupu obu `AiRuns`.

Finalny live baseline używa wyłącznie danych syntetycznych, wymaga osobnej
zgody, preflightu oraz limitów 48 logicznych wywołań, 56 prób i USD 3.00. Plan v2 zawiera
dokładnie 46 wywołań, najwyżej 46 prób i wymaga `AI_MAX_RETRIES=0`. Credential-free
`npm run eval:live:preflight` oblicza ten sam plan: zaakceptowany runtime Luna/2048 ma ceiling
1,171,326 USD micros i 1,828,674 micros zapasu do capu, a Terra/2048 ma ceiling 8,595,433
USD micros i pozostaje wyłącznie comparison scenario ponad capem. Trzy osobno autoryzowane
one-shot baseline zatrzymały się fail-closed przed raportem jakości; trzeci zatrzymał się na
pierwszym `P01/JUDGE` z
`INVALID_STRUCTURED_OUTPUT`. Nie wykonano rerunu,
continuation, smoke testu ani diagnostycznego requestu. Wersjonowana korekta offline rozdziela
statyczny transport schema od lokalnych bindingów i pozwala raportować wyłącznie kompletnie
rozliczone post-response invalid JUDGE jako fail-closed `REJECT`; nie autoryzuje kolejnego
baseline. Model profile contract ma wersję `narrative-quality-model-profile-v2`, AI pozostaje
domyślnie wyłączone, a faza pozostaje w `REVIEW`. Nigdy nie commituj `.env` ani kluczy. Pełny
kontrakt, konfiguracja, bezpieczeństwo i ograniczenia są opisane w `docs/ai-gateway.md`.

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
npm run eval:schema:check
npm run eval:offline
npm run test:unit
npm run test:integration
npm run build
npm run verify
npx playwright install chromium
npm run verify:full
```

Testy i scenariusz referencyjny nie używają internetu ani bieżącej daty. Szczegóły
architektury, zakresu i znanych ograniczeń znajdują się w `docs/`.
