# Strategia testów

## Poziomy testów

### Testy jednostkowe

Uruchamiają czystą domenę bez UI i bazy. Obejmują:

- walidację briefu, hard constraints i każdej wagi soft preferences;
- ścisłe daty kalendarzowe, w tym daty nieistniejące i poprawne lata przestępne;
- wszystkie dozwolone przejścia workflow i reprezentatywne przejścia niedozwolone;
- `Money`, wszystkie `PriceType`, UNKNOWN, waluty i bezpieczne minor units;
- `source-snapshot-v2`: zamknięte typy źródła, wersje i SHA-256, reguły fixture/live/expiry,
  nullable URL/attribution/currency, wymaganą terms policy, canonical equality oraz legacy view
  bez syntezy i backfillu;
- `offer-price-v2`: zgodność obowiązkowego subtotalu, fees i all-in total, fail-closed dla
  wymaganych `UNKNOWN` oraz jawne `COMPLETE`/`PARTIAL`/`UNKNOWN` opłat warunkowych i
  opcjonalnych bez dodawania ich do budżetu lub score;
- canonical `planning-provider-manifest-v1`, dokładnie trzy role, tryby fixture/live,
  zmianę fingerprintu po zmianie wersji/policy i brak miejsca na sekrety lub raw config;
- `provider-execution-policy-v1`: granice 25/26 rzeczywistych prób upstream, także wielu prób
  wewnątrz jednego live `search()`, obniżalne limity, FIFO i concurrency,
  timeout, cancellation siblings, pojedynczy attempt, rate-limit fail-fast, zero fallbacku,
  zamknięte błędy oraz privacy-safe audit bez raw danych;
- 13 kodów odrzucenia, wiele powodów, deduplikację i granice buildera;
- komponenty score, stabilny tie-breaker i diversity selection;
- kontrolowany niedobór dwóch lub zera opcji;
- dokładną konwersję major → minor units przez zamknięty `currency-fraction-digits-v1`,
  akceptację PLN/EUR i odrzucenie JPY/KWD/nieznanych kodów;
- literalne golden SHA-256 zamrożonych fingerprintów v0 z `main@1b8a852` i v1 z
  `main@ad7a909`, odrębność bieżącego v2 oraz zmianę v2 po zmianie provider manifestu;
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
  control/bidi i secret-shaped values, opaque provenance keys wyprowadzane wyłącznie z
  bezpiecznych `factId` oraz zachowanie pełnego lokalnego/JUDGE-safe kontraktu;
- deterministic `narrative-generation-view-v1`: tylko fakty `KNOWN`, brak provenance,
  `UNKNOWN`/`MISSING`, source URLs/keys/provider/external IDs, exact canonical
  fingerprint/size/immutability i pełnoserializacyjne privacy sentinels; strict projector
  mapuje każdy wspierany fact key/value shape, odrzuca dodatkowe pola oraz nie skanuje
  niezależnych values, object keys, fact IDs ani fingerprintów pod kątem przypadkowych source
  substrings; regresje obejmują `1`, `TRAIN`, `PRG`, `X`, `XY`, `XYZ` i kolizje SHA-256;
- provider GENERATE `{blocks}` only, limit 6, code-owned context fingerprint, exact fixture,
  cached, combined i no-op disclosures, zbiorczy `UNKNOWN`/`MISSING` block, stable order,
  final limit 8 oraz fail-closed ambiguity/tamper/restricted-reference tests; fact-aware
  finalizer dopuszcza cytowany `KNOWN` transport/hotel/destination przy osobnym non-`KNOWN`
  koszcie, lecz odrzuca koszt, `free`/`included`, potwierdzenie ceny/dostępności, wymyśloną
  liczbę/walutę, provider-owned disclosure oraz excluded fact ID;
- `narrative-quality-context-v2`, exact constraint snapshot, candidate/model/grounded
  fingerprints oraz kompletne version bindings;
- strict `JUDGE` input/output: pełny strukturalny rubric v2 z exact version/fingerprint,
  provider `{findings}` only bez fingerprintów/status array, zamknięte reason/dimension/
  severity, existing block/fact references, duplicate-finding rejection, code-owned exact
  fingerprints oraz osiem statuses wyprowadzanych z findings;
- safety precheck dla URL/Markdown/HTML/script/event handlers/control/bidi, inline,
  full/collapsed/image reference-style links, definitions z title/whitespace, autolinks,
  excluded values i money format oraz bezpieczne przypadki, których nie wolno overblockować;
  semantycznie zła kwota, nowe obliczenie i wypełnienie `UNKNOWN` pozostają przypadkami
  `JUDGE` zgodnie z frozen stage labels;
- wszystkie gałęzie code-owned publication policy: osiem `PASS` i zero findings jako jedyny
  `PUBLISH`;
- strict loader i canonical fingerprint frozen datasetu, exact 32/12/20/18 distribution,
  fact-key resolution, critical/sentinel membership i malformed goldens;
- confusion matrix, precision/recall/F1, macro-F1, dimension macro-F1, stability, threshold
  edges, percent deltas oraz call/attempt/cost caps na hand-calculated fixtures;
- deterministic contract replay, privacy-safe report i baseline binding bez raw content,
  z jawnym `evidenceKind=CONTRACT_REPLAY` i `modelQualityMeasured=false`;
- executable E2E `requiredProperties`: niezależne deterministic oracle PASS/FAIL dla każdego
  ID z E01–E04, bez używania decyzji/dimensions/findings/reasons `JUDGE`, oraz regresję, w
  której naruszenie właściwości przegrywa mimo ośmiu `PASS` i zera findings;
- executable parity runtime Zod z frozen JSON Schema, obejmujące drift required/property,
  enum, min/max, strictness, counts, literal version i nested `requiredProperties`;
- integer-only price arithmetic oraz live guard blokujący brak opt-in, credentiali, znanej
  ceny, poprawnych caps lub budżetu jeszcze przed pierwszym provider call;
- safe review/rejection/publication bundles, exact generate/judge links, legacy nullability i
  brak candidate/raw content w internal review metadata;
- exact P01 offline proof przez oficjalny OpenAI SDK, prawdziwy request/context/schema i
  kontrolowany fake fetch z sentinelem liczby wywołań;
- provider schema audit dowodzący, że JUDGE v3 zawiera tylko closed findings, oraz osobny
  local binding audit dla fingerprints i derived statuses;
- atomowy mapper `NarrativeRuns`/`OptionNarratives`/`NarrativeFactReferences` z walidacją
  dokładnego audytu AI oraz historycznym scalar `NarrativeRuns.aiRunId`;
- kontrakty rzeczywistych wywołań obu oficjalnych SDK przez transport HTTP in-memory;
- structured outputs, metadata przed parserami i pełną klasyfikację terminalnych Responses
  API: completed/incomplete/failed/cancelled/queued/in-progress, max output, content filter,
  refusal, malformed JSON, transport schema oraz jawne context/narrative-finalization/
  dimension/finding binding; osobny test odróżnia malformed raw transport jako
  `TRANSPORT_SCHEMA_VALIDATION`, exact request/context mismatch jako `CONTEXT_BINDING` i
  deterministic policy rejection jako `NARRATIVE_FINALIZATION`;
- zamknięty `AiFailureExecutionEvidence`, jawne `providerCallAttempted` i
  `validationFailureStage`, zachowanie evidence przez durable `aiRunId`, brak raw contentu w
  serializacji/persistence/stdout oraz settlement failed attempt wyłącznie z kompletnego usage;
- timeout, retry, zamknięty katalog błędów oraz redakcję kluczy i nagłówków;
- dokładnie jeden allowlistowany `AI_PRE_START_FAILURE` dla każdej próby `GENERATE`/`JUDGE`
  bez durable `STARTED`, bez `aiRunId`/raw danych i zawsze z `providerCallAttempted=false`;
- blokadę live smoke, brak credentiali i dokładnie jedno wywołanie po jawnym opt-in.
- `offer-freshness-policy-v1` z injected clock: LIVE przed/na/po expiry i `null`, zerowy
  margines oraz brak odczytu zegara dla fixture i `INTERNAL_RULE`;
- Duffel v2 offline: allowlisted Zod projection, Search Policy v1, wstrzykiwany i wersjonowany
  origin catalog związany z manifest/query identity, destination IATA allowlist, maksymalny
  fan-out i limit 9 adults, odrzucenie błędnych dat/waluty/pustych destinations przed tokenem i
  siecią, headers, two-slice/segments/timezones/carriers, PLN/EUR minor units, mandatory
  arithmetic, `UNKNOWN` services dla endpointowej fixture oraz osobną syntetyczną fixture
  services, envelope/per-offer validation z zachowaniem poprawnych siblings, ponad 200 ofert
  bez sztucznego limitu elementów, limit 64 MiB odpowiedzi, pełny segmentowy
  sort/dedup/truncation, exact manifest identity przed pustym wynikiem oraz TEST lineage jako
  `LIVE`;
- zamknięte 429/5xx/network/invalid JSON/schema/timeout/cancellation/partial-destination bez
  raw body, provider text, headerów, stack trace lub tokenu oraz dokładnie jeden
  `executeUpstream` permit per fizyczny request;

Scenariusz referencyjny 2B wymaga dokładnie 28 zbudowanych, 6 poprawnych i 22
odrzuconych kandydatów. Wynik to Praga `BEST_OVERALL`, Wiedeń `MOST_CONVENIENT` i
Budapeszt `BEST_VALUE`, identyczne przy ponownym uruchomieniu.

### Testy integracyjne

Uruchamiają prawdziwy serwer CAP z SQLite in-memory i testują kontrakt OData. Pipeline
deterministyczny wraz z kontraktem 4B0 sprawdza między innymi:

- odrzucenie `startPlanning` dla brakującego briefu i statusu `DRAFT`;
- sukces dla `CONSTRAINTS_CONFIRMED`;
- audyt kolejności `SEARCHING` → `CANDIDATES_VALIDATED` → `OPTIONS_READY`;
- zapis dokładnie trzech ról i wszystkich powiązań do trip/workflow/planning run;
- kanoniczny provider manifest/fingerprint, policy v1, alias `europe-reference-v1`, engine i
  scoring lineage na wszystkich nowych rekordach;
- 22 odrzuconych kandydatów, szczegóły i 13 grup kodów;
- znormalizowane `source-snapshot-v2`, `BudgetBreakdowns` i 7 `BudgetItems` na opcję;
- cztery kolekcje conditional/optional charges na opcję, pełne
  label/condition/payable-at/mandatory semantics, zachowanie jawnej kompletności,
  fingerprint/persistence oraz brak wpływu na istniejący budżet/ranking;
- bezpieczne wewnętrzne `ProviderExecutionRecords`, ich call sequence/fingerprint/count,
  odrzucenie utraconego terminalnego suffixu oraz brak publicznego endpointu i raw
  request/response/error/header;
- zgodność sum confirmed/estimated/unknown z agregatem karty;
- akceptację PLN/EUR przez pełny przepływ CAP i odrzucenie JPY/KWD/nieznanych kodów przed
  persistence; EUR przechodzi również przez grounded narrative i kodowy display;
- idempotentne ponowne wywołanie v2 bez duplikatów;
- dwa równoległe wywołania `startPlanning` koaleskowane do jednego pipeline'u i runu;
- kontrolowany niedobór z diagnostyką i zerem częściowych opcji oraz frozen replay historycznego
  `INSUFFICIENT_OPTIONS` v1 bez provider call/write;
- rollback wszystkich zapisów po awarii providera.
- realny CAP/SQLite read checkpoint → kontrolowany provider wait bez aktywnej transakcji →
  niezależny write → rewalidowany product write oraz fail-closed przy zmianie workflow bez
  zgodnego równoległego runu;
- wstrzyknięcie mieszanego profilu Duffel TEST + fixture accommodation/places przez istniejące
  seams serwisu, z 24 audytowanymi calls, trzema niezmienionymi rolami selection i bez sieci;
- INSERT `STARTED` oraz aktualizację tego samego `AiRuns` do `SUCCEEDED`/`FAILED`;
- pełne bezpieczne metadata runu, terminalne response ID/status/incomplete reason, opcjonalne
  powiązanie `PlanningRun` i brak raw payloadów;
- realny readback terminalnego `FAILED` z usage/attempts/latency i prawdziwym UUID, przy
  zerowych rekordach produktu/review oraz nullowych nowych polach dla legacy/`STARTED`;
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
- zapis exact synthetic E2E fixture przez produkcyjne `CapAiRunStore`, recorder i
  `CapNarrativeReviewWriter`, następnie odczyt wszystkich exact IDs/fingerprintów, bloków i
  referencji z realnego SQLite oraz zachowanie review/produktu po cleanup obu `AiRuns`;
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
- realny post-upgrade replay frozen exact v1 i exact v0 przy `OPTIONS_READY`: ten sam ID,
  jeden run, trzy opcje, trzy przejścia, nullowe nowe pola, zero provider calls, zero zapisów i
  zero backfillu;
- kolejność v2 → frozen v1 → exact v0 i pierwszeństwo nowszego istniejącego runu nawet przy
  równoczesnym niespójnym starszym wpisie;
- brak legacy replay dla manifestu live lub mieszanego: zero silent live → fixture fallback,
  zero provider substitution i fail-closed bez zmian persistence;
- fail-closed 409 bez wywołań i zmian dla exact v0 z brakującą opcją, błędną wersją albo
  `INSUFFICIENT_OPTIONS` oraz 500 `INVALID_GROUNDED_OPTION_CONTEXT` przed gatewayem/AiRun dla
  narracji z legacy runu;
- brak narracji i brak zmiany deterministycznej opcji po `AI_DISABLED`, błędzie providera,
  niepoprawnej referencji albo awarii durable `STARTED`; pre-`STARTED` nie tworzy review ani
  fikcyjnego UUID, nie wywołuje adaptera i emituje jeden bezpieczny operational signal;
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

`npm run verify` uruchamia kolejno lint, typecheck, `eval:schema:check`, deterministic
contract replay, unit, integration i build. `npm run verify:full` uruchamia ten sam zestaw
oraz E2E. Przed zakończeniem pracy wymagany jest `verify`, a przed PR — `verify:full`.
Testów nie wyłącza się, nie pomija i nie rozwadnia w celu uzyskania zielonego wyniku.

Testy adapterów nie patchują globalnego `fetch`: fabryka klienta otrzymuje lokalny,
kontrolowany transport, który pozwala sprawdzić rzeczywisty payload SDK bez sieci. Żaden
test w `test`, `verify` ani `verify:full` nie wymaga credentiali i nie wykonuje płatnego
requestu. Testy Phase 4B0 używają wyłącznie fixture/in-memory doubles: nie wykonują calli do
zewnętrznego travel providera ani Duffel, a ścieżka live nie ma cichego fallbacku do fixture.

## Offline narrative-quality contract replay

Aktualny `narrative-quality-v2` (przy zachowanym, niezmienionym v1) zawiera dokładnie 32 synthetic semantic cases — 12
`PUBLISH`, 20 `REJECT`, w tym 18 critical — oraz cztery synthetic end-to-end contexts.
Loader waliduje schema, stable IDs/fact keys, labels, reason codes, dimensions, membership i
literalny canonical fingerprint. `npm run eval:schema:check` najpierw porównuje canonical
runtime Zod z frozen checked-in JSON Schema. Następnie offline harness kopiuje frozen
expected labels do actual i przechodzi przez resolvery, metryki, gates oraz privacy-safe
report path bez promptów, kontekstów, narracji i raw payloads. To jest
`CONTRACT_REPLAY` z `modelQualityMeasured=false`, a nie baseline ani dowód jakości modelu.

In-memory E2E sprawdza też wersjonowany katalog `requiredProperties` na exact
candidate/context/model view/constraints. Wyniki tych niezależnych oracle są allowlistowane
w raporcie; all-`PASS` `JUDGE` nie może zamaskować property failure. Nazwa
`publicationBundleLinkageValidInMemory` celowo nie sugeruje zapisu do bazy. Realną
persistence, atomowość i linkage dowodzi osobny test produkcyjnych writerów na CAP/SQLite.

Golden stage jest także kontraktem granicy: tylko format/safety cases R09 i R20 są
`PRECHECK`; wrong/new money, calculation i semantic authored `UNKNOWN` fill
(R07/R08/R10) dochodzą do `JUDGE`. Produktowy GENERATE nie otrzymuje non-`KNOWN` facts i
ma code-owned limitation block, ale semantic dataset nadal mierzy JUDGE na historycznie
zaakceptowanych stage labels. Test regresyjny chroni oba rozdzielone kontrakty.

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
Plan v2 ma dokładnie 46 calls i wymaga `AI_MAX_RETRIES=0`. Osobny
`npm run eval:live:preflight` działa bez opt-inów i credentiali, nie konstruuje executora,
adaptera, gatewaya ani bazy oraz używa tej samej czystej logiki planu i kosztu. Oficjalny
snapshot cen z 2026-08-21 oraz integer-only cost engine dają dla zaakceptowanego runtime
`OPENAI / gpt-5.6-luna / low / 2048` ceiling 1,171,326 USD micros: 346,331 dla
`GENERATE` i 824,995 dla `JUDGE`. Zapas do capu USD 3.00 wynosi 1,828,674 USD micros,
a workload fingerprint to
`fcf8cc7d3117274b6dc63ba9c4f663e9b49d40c0d14df8a83accae20206d5947`.
`gpt-5.6-terra / low / 2048` pozostaje wyłącznie scenariuszem porównawczym i z ceiling
8,595,433 USD micros jest blokowany przez niezmieniony cap. Nie jest to ścieżka fallbacku.
Preflight nie jest uruchamiany przez test, build, start, `verify`, `verify:full` ani CI.

Trzy osobno autoryzowane one-shot runy zatrzymały się fail-closed bez rerunu. Run z
2026-08-23 zatrzymał się na 18/46 (`R06`, `JUDGE`, `EMPTY_MODEL_OUTPUT`); 17 kompletnie
rozliczonych operacji ma subtotal 32,386 USD micros, a próba 18 nie ma kompletnego
accounting. Drugi run ze źródła `a4785502c6fe01e978dea1a85aa8d90ff66b90a6`
zatrzymał się na 23/46 (`R12`, `JUDGE`, `INCOMPLETE_MODEL_OUTPUT`, status `INCOMPLETE`,
reason `MAX_OUTPUT_TOKENS`); accounting wszystkich 23 prób jest kompletny, a znany koszt
wynosi 45,732 USD micros. Nie powstał report jakości ani accepted manifest, a drugi run nie
wykonał `GENERATE`. Trzeci run ze źródła
`abf0f4b258c5950381e597b0192580527d71953f` zatrzymał się na `P01 / JUDGE / 1/46` z
`INVALID_STRUCTURED_OUTPUT`, niepełnym accountingiem i jednym `FAILED` `AiRun`; zero known
attempts/cost było tylko settled subtotalem. Nie było review, narrative, `GENERATE`, retry,
resume ani fallbacku. Ta poprawka wykonuje zero live/provider calls, kosztuje USD 0 i nie
autoryzuje kolejnego baseline.

Regresje runnera dowodzą trzech osobnych ścieżek. Pre-request schema failure ma
`providerCallAttempted=false`, attempts 0 i kompletne rozliczenie zera. Post-request failure
bez usage pozostawia accounting niepełny i zatrzymuje cały run. Kompletny post-response
invalid `JUDGE` z exact profile, jednym attemptem, usage, integer-only settlement i durable
`FAILED` linkage nie wykonuje retry ani dodatkowego calla: tworzy fail-closed `REJECT`, idzie
do kolejnej planowanej operacji i kończy pełnym reportem `FAIL`. Primary zachowuje 100%
strict validity, stability repeat ma osobny gate 8/8 i nie liczy invalid jako agreement, a E2E
ma osobny judge-validity gate i nigdy nie buduje publication bundle z invalid outputu.
Regresja accepted-manifest zmienia critical case i koszty operacji, pozostawia stare passing
metrics/gates/summary, ponownie liczy fingerprint i dowodzi odrzucenia przez kanoniczny rebuild;
osobny sentinel dowodzi odrzucenia dodatkowego raw pola raportu.
Safe preflight zawiera exact profiles, wersje, fingerprint workloadu, wersję i datę weryfikacji
cennika, planowane calls/attempts/koszt oraz limity. Safe failure przenosi wyłącznie zamknięte
allowlistowane metadata.

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
