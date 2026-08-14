# Strategia testów

## Poziomy testów

### Testy jednostkowe

Uruchamiają czystą domenę bez UI i bazy. Obejmują:

- walidację briefu, hard constraints i każdej wagi soft preferences;
- ścisłe daty kalendarzowe, w tym daty nieistniejące i poprawne lata przestępne;
- wszystkie dozwolone przejścia workflow i reprezentatywne przejścia niedozwolone;
- `Money`, wszystkie `PriceType`, UNKNOWN, waluty i bezpieczne minor units;
- 13 kodów odrzucenia, wiele powodów, deduplikację i granice buildera;
- komponenty score, stabilny tie-breaker i diversity selection;
- kontrolowany niedobór dwóch lub zera opcji;
- dokładną konwersję major → minor units przez zamknięty `currency-fraction-digits-v1`,
  akceptację PLN/EUR i odrzucenie JPY/KWD/nieznanych kodów;
- mapowanie awarii providera na kontrolowany kod bez ujawnienia jego komunikatu.
- task-aware profile `DECIDE`/`GENERATE`/`JUDGE`, migrację aliasów, walidację effort,
  task-specific limity, obowiązkowy model po zmianie providera i blokadę `AI_DISABLED`
  przed fingerprintem;
- routing bez per-request provider override, przekazanie profilu per call, UUID runu,
  walidację każdego pola metadanych oraz `configuredModel`/`responseModel`;
- asynchroniczny lifecycle recordera, wszystkie trzy przypadki fail-closed i brak payloadów
  w eventach;
- mapowanie persistent recordera, retencję i `expiresAt`, duplicate/state transitions oraz
  kontrakt cleanup store;
- dokładną, deterministyczną konstrukcję `grounded-option-context-v1`, jego fingerprint,
  unikalne fact IDs oraz zmianę wszystkich identyfikatorów po zmianie exact context;
- jawne fakty `UNKNOWN` i `MISSING` bez uzupełniania wartości oraz ich poprawne użycie jako
  celów referencji;
- deterministyczne dwucyfrowe display values z minor units dla PLN/EUR, odrzucenie
  JPY/KWD/nieznanych kodów oraz `null` dla kwot `UNKNOWN`/`MISSING`;
- zgodność siedmiu kategorii budżetu z klasyfikacjami, walutą, partial sums,
  `unknownCategoryCount`, statusem agregatu, total, per-person i remaining;
- fail-closed lineage `providerFixtureVersion` i `scoringVersion` pomiędzy `PlanningRun`,
  `RankedOption`, `BudgetItems` i `SourceSnapshots`;
- rozwiązywalne source snapshot IDs transportu/noclegu, jawne wersje internal derivations i
  fail-closed dla dangling lub ambiguous source-context mappings;
- strict schema narracji, niepuste `factReferences`, exact context fingerprint i odrzucenie
  brakujących, pustych, obcych, nieaktualnych, powtórzonych lub częściowo błędnych referencji;
- offline konwersję tego samego schematu przez helpery structured output obu SDK;
- atomowy mapper `NarrativeRuns`/`OptionNarratives`/`NarrativeFactReferences` z walidacją
  dokładnego audytu AI oraz historycznym scalar `NarrativeRuns.aiRunId`;
- kontrakty rzeczywistych wywołań obu oficjalnych SDK przez transport HTTP in-memory;
- structured outputs, ponowną lokalną walidację, refusal i brak poprawnej treści;
- timeout, retry, zamknięty katalog błędów oraz redakcję kluczy i nagłówków;
- blokadę live smoke, brak credentiali i dokładnie jedno wywołanie po jawnym opt-in.

Scenariusz referencyjny 2B wymaga dokładnie 28 zbudowanych, 6 poprawnych i 22
odrzuconych kandydatów. Wynik to Praga `BEST_OVERALL`, Wiedeń `MOST_CONVENIENT` i
Budapeszt `BEST_VALUE`, identyczne przy ponownym uruchomieniu.

### Testy integracyjne

Uruchamiają prawdziwy serwer CAP z SQLite in-memory i testują kontrakt OData. Faza 2C
sprawdza między innymi:

- odrzucenie `startPlanning` dla brakującego briefu i statusu `DRAFT`;
- sukces dla `CONSTRAINTS_CONFIRMED`;
- audyt kolejności `SEARCHING` → `CANDIDATES_VALIDATED` → `OPTIONS_READY`;
- zapis dokładnie trzech ról i wszystkich powiązań do trip/workflow/planning run;
- wersje `europe-reference-v1`, engine i scoringu;
- 22 odrzuconych kandydatów, szczegóły i 13 grup kodów;
- znormalizowane `SourceSnapshots`, `BudgetBreakdowns` i 7 `BudgetItems` na opcję;
- zgodność sum confirmed/estimated/unknown z agregatem karty;
- akceptację PLN/EUR przez pełny przepływ CAP i odrzucenie JPY/KWD/nieznanych kodów przed
  persistence; EUR przechodzi również przez grounded narrative i kodowy display;
- idempotentne ponowne wywołanie bez duplikatów;
- dwa równoległe wywołania `startPlanning` koaleskowane do jednego pipeline'u i runu;
- kontrolowany niedobór z diagnostyką i zerem częściowych opcji;
- rollback wszystkich zapisów po awarii providera.
- INSERT `STARTED` oraz aktualizację tego samego `AiRuns` do `SUCCEEDED`/`FAILED`;
- pełne bezpieczne metadata runu, opcjonalne powiązanie `PlanningRun` i brak raw payloadów;
- odrzucenie brakującego lub ponownie kończonego runu oraz cleanup wyłącznie przeterminowanych;
- brak publicznego endpointu `/trip-planner/AiRuns`.
- pełną offline composition `AiGateway` + mock adapter + persistent recorder + real store;
- test-only handler CAP z SQLite, aktywną transakcją requestu i timeoutem pięciu sekund,
  który potwierdza fail-closed zamiast circular wait;
- fazową granicę wykonania, committed `STARTED` widoczny w niezależnym odczycie adaptera
  oraz przetrwanie `SUCCEEDED` po rollbacku późniejszego product write.
- bound action `RankedOptions.generateNarrative()` z realnym CAP i SQLite: profil
  `GENERATE`, committed `STARTED` przed adapterem, ścisłe linkage narracji oraz atomowy
  product write po terminalnym audycie;
- realny cleanup wygasłego `AiRun` udanej narracji, po którym produkt pozostaje czytelny,
  spójny i nie ma dangling mandatory database associations;
- regresyjne HTTP 500 dla `INVALID_GROUNDED_OPTION_CONTEXT` i
  `INVALID_NARRATIVE_PERSISTENCE`;
- brak narracji i brak zmiany deterministycznej opcji po `AI_DISABLED`, błędzie providera,
  niepoprawnej referencji albo awarii durable `STARTED`;
- przetrwanie `SUCCEEDED` po wymuszonym rollbacku późniejszego zapisu narracji bez
  odtworzenia circular wait.

### Playwright

Dwa stabilne scenariusze Chromium przechodzą oba wyniki planowania. Pierwszy obejmuje
formularz, edycję zapisanego `DRAFT`, wszystkie ważne constraints i preferences,
potwierdzenie, planowanie, dokładnie trzy karty, role, koszt, transport, źródła fixture,
budżet i diagnostykę odrzuceń. Drugi wymusza `INSUFFICIENT_OPTIONS`, sprawdza brak
częściowych kart oraz utworzenie nowego briefu z obecnych danych. Testy używają etykiet i
stabilnych `data-testid`, ustawiają suwaki klawiaturą, sprawdzają brak błędów konsoli, a
scenariusz referencyjny także widok 390×844 bez poziomego overflow.

Test nie kontaktuje się z internetem, nie korzysta z zegara systemowego i używa stałych dat
`2026-10-10`–`2026-10-13`. Przy błędzie zachowuje screenshot, trace i raport HTML.

## Weryfikacja

`npm run verify` uruchamia lint, typecheck, unit, integration i build. `npm run verify:full`
uruchamia ten sam zestaw oraz E2E. Przed zakończeniem pracy wymagany jest `verify`, a przed
PR — `verify:full`. Testów nie wyłącza się, nie pomija i nie rozwadnia w celu uzyskania
zielonego wyniku.

Testy adapterów nie patchują globalnego `fetch`: fabryka klienta otrzymuje lokalny,
kontrolowany transport, który pozwala sprawdzić rzeczywisty payload SDK bez sieci. Żaden
test w `test`, `verify` ani `verify:full` nie wymaga credentiali i nie wykonuje płatnego
requestu.

## Manualny smoke test AI

`npm run ai:credentials:check` wykonuje wyłącznie lokalną kontrolę obecności wymaganych
zmiennych i wypisuje bezpieczne statusy bez wartości sekretów. `npm run ai:smoke:openai` i
`npm run ai:smoke:anthropic` wymagają `AI_LIVE_SMOKE_ENABLED=true` oraz klucza wybranego
providera. Każdy skrypt wykonuje dokładnie jedno minimalne wywołanie o strukturalnym
wyniku. `npm run ai:smoke` uruchamia je sekwencyjnie.

Smoke testy są celowo poza CI i standardową weryfikacją, ponieważ są płatne, zależą od
zewnętrznej dostępności i uprawnień konta. Nie wolno ich uruchamiać automatycznie ani
używać do omijania testów offline. Evale LLM nie zastąpią testów twardych reguł,
persistence ani arytmetyki kodu.

Testy `AiRuns` uruchamiają prawdziwy CAP 10 i SQLite in-memory. Store wykonuje krótkie,
niezależne transakcje i nie utrzymuje transakcji podczas call providera. Aktywna transakcja
DB requestu jest jawnie niedozwolona i testowana, ponieważ przy pojedynczym połączeniu
SQLite prowadziłaby do circular wait. Kontrakt cleanup jest testowany, ale testy nie
uruchamiają schedulera, bo nie istnieje on w Fazie 3B1.

Testy narracji 3B2 wstrzykują adapter `GENERATE` działający wyłącznie w pamięci. Nie czytają
credentiali, nie uruchamiają `JUDGE` i nie kontaktują się z providerem. Ten adapter również
ponownie używa requestowego schematu, dlatego przypadek obcej referencji kończy się
`INVALID_STRUCTURED_OUTPUT` i terminalnym `FAILED`, zanim powstanie persistence produktu.
Osobny test lifecycle wygasza terminalny audyt, uruchamia prawdziwy
`CapAiRunStore.deleteExpired()` i czyta zachowane rekordy produktu po usunięciu `AiRun`.
