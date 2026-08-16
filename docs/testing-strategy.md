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
- literalny golden SHA-256 zamrożonego fingerprintu v0 z `main@1b8a852` oraz jego różnicę
  względem bieżącego fingerprintu v1;
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
- zachowanie części confirmed/estimated każdej kategorii, w tym mieszanego
  `ADDITIONAL_FEES`, przez kalkulator, mapper persistence i grounded context;
- odczyt utrwalonej `PlanningRuns.currencyContractVersion` oraz fail-closed dla brakującej lub
  nieobsługiwanej wersji historycznej bez runtime backfillu;
- fail-closed lineage `providerFixtureVersion` i `scoringVersion` pomiędzy `PlanningRun`,
  `RankedOption`, `BudgetItems` i `SourceSnapshots`;
- rozwiązywalne source snapshot IDs transportu/noclegu, jawne wersje internal derivations i
  fail-closed dla dangling lub ambiguous source-context mappings;
- strict schema narracji, niepuste `factReferences`, exact context fingerprint i odrzucenie
  brakujących, pustych, obcych, nieaktualnych, powtórzonych lub częściowo błędnych referencji;
- deterministic `narrative-model-view-v1`, usunięcie raw URL/external ID, HTML, znaków
  control/bidi i secret-shaped values, zachowanie dozwolonych faktów oraz canonical
  fingerprint/size/immutability;
- `narrative-quality-context-v1`, exact constraint snapshot, candidate/model/grounded
  fingerprints oraz kompletne version bindings;
- strict `JUDGE` input/output: dokładnie osiem wymiarów, zamknięty katalog reason codes i
  severity, istniejące block/fact references, spójność findings z wymiarami i odrzucenie
  unknown fields lub mismatched fingerprints;
- safety precheck dla URL/Markdown/HTML/script/event handlers/control/bidi, excluded values i
  money format oraz bezpieczne przypadki, których nie wolno overblockować; semantycznie zła
  kwota, nowe obliczenie i wypełnienie `UNKNOWN` pozostają przypadkami `JUDGE` zgodnie z
  frozen stage labels;
- wszystkie gałęzie code-owned publication policy: osiem `PASS` i zero findings jako jedyny
  `PUBLISH`;
- strict loader i canonical fingerprint frozen datasetu, exact 32/12/20/18 distribution,
  fact-key resolution, critical/sentinel membership i malformed goldens;
- confusion matrix, precision/recall/F1, macro-F1, dimension macro-F1, stability, threshold
  edges, percent deltas oraz call/attempt/cost caps na hand-calculated fixtures;
- offline end-to-end harness, privacy-safe report i baseline binding bez raw content;
- integer-only price arithmetic oraz live guard blokujący brak opt-in, credentiali, znanej
  ceny, poprawnych caps lub budżetu jeszcze przed pierwszym provider call;
- safe review/rejection/publication bundles, exact generate/judge links, legacy nullability i
  brak candidate/raw content w internal review metadata;
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
- pełną granicę 3B3: krótki read → `GENERATE` → precheck → `JUDGE` → krótki write, bez
  otwartej transakcji produktu podczas obu provider calls;
- publish po exact terminalnych `SUCCEEDED` obu audytów oraz atomowy zapis review, findings i
  narracji ocenionej byte-for-byte;
- precheck reject z zerem `JUDGE` calls, semantic reject, invalid judge output, audit/linkage
  failure i product-write rollback: safe durable review metadata, zero candidate text i zero
  częściowych rekordów produktu narracji;
- brak publicznych endpointów `AiRuns`, `NarrativeReviewRuns` i
  `NarrativeReviewFindings`;
- realny cleanup wygasłego `AiRun` udanej narracji, po którym produkt pozostaje czytelny,
  spójny i nie ma dangling mandatory database associations;
- regresyjne HTTP 500 dla `INVALID_GROUNDED_OPTION_CONTEXT` i
  `INVALID_NARRATIVE_PERSISTENCE`;
- realną persistence mieszanego `ADDITIONAL_FEES` z niezerowymi częściami confirmed/estimated
  oraz bezpieczny nullable/no-default upgrade dla nieoznaczonych `PlanningRuns` legacy;
- realny post-upgrade replay exact v0 przy `OPTIONS_READY`: ten sam ID, jeden run, trzy opcje,
  trzy przejścia, nullowe nowe pola, zero provider calls, zero zapisów i zero backfillu;
- pierwszeństwo istniejącego v1 nawet przy równoczesnym niespójnym exact v0;
- fail-closed 409 bez wywołań i zmian dla exact v0 z brakującą opcją, błędną wersją albo
  `INSUFFICIENT_OPTIONS` oraz 500 `INVALID_GROUNDED_OPTION_CONTEXT` przed gatewayem/AiRun dla
  narracji z legacy runu;
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

## Offline narrative-quality eval

Frozen `narrative-quality-v1` zawiera dokładnie 32 synthetic semantic cases — 12
`PUBLISH`, 20 `REJECT`, w tym 18 critical — oraz cztery synthetic end-to-end contexts.
Loader waliduje schema, stable IDs/fact keys, labels, reason codes, dimensions, membership i
literalny canonical fingerprint. Offline harness używa wyłącznie adapterów in-memory,
tworzy privacy-safe raport bez promptów, kontekstów, narracji i raw payloads oraz jest częścią
standardowej weryfikacji.

Golden stage jest także kontraktem granicy: tylko format/safety cases R09 i R20 są
`PRECHECK`; wrong/new money, calculation i `UNKNOWN` fill (R07/R08/R10) dochodzą do
`JUDGE`. Test regresyjny ma chronić tę granicę, szczególnie sentinel R07/R10. Ewentualna
szersza interpretacja exact-money precheck jest punktem review, nie pretekstem do zmiany
frozen labels.

## Manualny smoke i finalny live baseline AI

`npm run ai:credentials:check` wykonuje wyłącznie lokalną kontrolę obecności wymaganych
zmiennych i wypisuje bezpieczne statusy bez wartości sekretów. `npm run ai:smoke:openai` i
`npm run ai:smoke:anthropic` wymagają `AI_LIVE_SMOKE_ENABLED=true` oraz klucza wybranego
providera. Każdy skrypt wykonuje dokładnie jedno minimalne wywołanie o strukturalnym
wyniku. `npm run ai:smoke` uruchamia je sekwencyjnie.

Smoke testy są celowo poza CI i standardową weryfikacją, ponieważ są płatne, zależą od
zewnętrznej dostępności i uprawnień konta. Nie wolno ich uruchamiać automatycznie ani
używać do omijania testów offline. Evale LLM nie zastąpią testów twardych reguł,
persistence ani arytmetyki kodu.

Finalny live baseline jest osobną ścieżką od smoke. Wymaga
`AI_LIVE_EVAL_ENABLED=true`, istniejącego gateway opt-in, credentiali, znanych
wersjonowanych cen i osobnej zgody na dokładny plan. Preflight oraz sequential reservation
guard egzekwują maksymalnie 48 logical calls, 56 attempts i USD 3.00 przed każdym call.
Plan v1 ma dokładnie 46 calls i wymaga `AI_MAX_RETRIES=0`; checked-in katalog cen nie zawiera
niezatwierdzonych stawek, więc obecnie blokuje się przed pierwszym call.
Nie jest uruchamiany przez test, build, start, `verify`, `verify:full` ani CI. W trakcie
implementacji nie wykonano żadnego live call; rzeczywisty koszt wynosi USD 0.

Testy `AiRuns` uruchamiają prawdziwy CAP 10 i SQLite in-memory. Store wykonuje krótkie,
niezależne transakcje i nie utrzymuje transakcji podczas call providera. Aktywna transakcja
DB requestu jest jawnie niedozwolona i testowana, ponieważ przy pojedynczym połączeniu
SQLite prowadziłaby do circular wait. Kontrakt cleanup jest testowany, ale testy nie
uruchamiają schedulera, bo nie istnieje on w Fazie 3B1.

Testy narracji 3B3 wstrzykują adaptery `GENERATE` i `JUDGE` działające wyłącznie w pamięci.
Nie czytają credentiali i nie kontaktują się z providerem. Oba ponownie używają requestowych
schematów, więc malformed output kończy się terminalnym `FAILED`, zanim powstanie produkt.
Osobne testy lifecycle wygaszają oba terminalne audyty, uruchamiają prawdziwy
`CapAiRunStore.deleteExpired()` i czytają zachowane review oraz rekordy produktu po
usunięciu `AiRuns`.
