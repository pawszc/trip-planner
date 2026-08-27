# Architektura

Backend wykorzystuje SAP CAP 10, TypeScript ESM i lokalny adapter SQLite. Frontend jest osobnym workspace React/Vite z semantycznymi, dostępnymi kontrolkami HTML. Vite przekazuje `/trip-planner` i `/health` do CAP.

## Warstwy backendu

- `domain/` — typy, błędy domenowe i czysta maszyna stanów workflow;
- `validation/` — czysta, testowalna walidacja briefu, hard constraints i soft preferences;
- `orchestration/` — ograniczony pipeline pobierania danych i budowania kandydatów;
- `providers/` — typowane kontrakty providerów, manifest/provenance i ograniczone wykonanie
  oraz stabilne adaptery fixture;
- `ai/` — task-aware profile LLM, routing, adaptery SDK, lokalna walidacja, redakcja,
  fail-closed recorder i wewnętrzna persistence `AiRuns`;
- `narratives/` — deterministyczny grounded context i model-safe view, fact IDs,
  wersjonowane kontrakty `GENERATE`/`JUDGE`, safety precheck, code-owned publication policy,
  fazowy odczyt oraz review i atomowy zapis zaakceptowanych narracji;
- `evals/` — offline dataset/harness, metryki, privacy-safe raporty, baseline binding,
  integer-only estymacja kosztu i fail-closed guard finalnego live baseline;
- `ranking/` — budżet, twarde filtrowanie, scoring i wybór zróżnicowanych wariantów;
- `persistence/` — kontrolowane mapowanie wyników domenowych na znormalizowane rekordy;
- serwis CAP — transport OData, trwałość, transakcje i kontrolowane błędy.

W contract v2 granica narracji ma dwa różne provider transports. GENERATE otrzymuje
`narrative-generation-view-v1` z samymi faktami `KNOWN` i zwraca najwyżej sześć bloków;
fingerprint oraz obowiązkowe provenance i `UNKNOWN`/`MISSING` disclosures tworzy kod.
JUDGE zwraca wyłącznie zamknięte findings; exact fingerprints i wszystkie osiem statusów są
lokalnie wiązane lub wyprowadzane. Finalny kandydat jest zweryfikowany przez ten sam
production finalizer w runtime i E2E, a publication pozostaje fail-closed.

## Model briefu i workflow

`TripRequest` przechowuje podstawowy brief oraz status jego potwierdzenia. Pola strukturalne `hardConstraints` i `softPreferences` używają jawnych typów CDS `HardConstraintProfile` i `SoftPreferenceProfile`. Hard constraints nie są swobodnym tekstem: budżet, okna czasowe, limity podróży i dozwolone środki transportu mają typowany kontrakt walidowany przez kod. Soft preferences przechowują wagi całkowite od 1 do 5, natomiast `pace` pozostaje osobnym polem briefu. Wartości domyślne profili pozwalają dotychczasowym klientom nadal tworzyć brief bez przesyłania nowych pól. CAP 10 publikuje te struktury w domyślnym kontrakcie OData jako jawne pola z prefiksami `hardConstraints_*` i `softPreferences_*`; osobny mapper serwisu składa je do zagnieżdżonych typów domenowych i materializuje z powrotem bez zmiany dotychczasowych pól API.

Daty briefu przechodzą przez jedną funkcję `parseStrictIsoDate`, która wymaga dokładnego
formatu `YYYY-MM-DD` i istniejącego dnia kalendarzowego. Ten sam walidator jest wykonywany
przy CREATE, UPDATE, `confirmConstraints` i `startPlanning`; round-trip UTC odrzuca między
innymi 29 lutego w roku nieprzestępnym oraz nieistniejące dni miesiąca.

Status `TripRequest` opisuje lifecycle briefu: `DRAFT` oznacza wersję roboczą, a `CONSTRAINTS_CONFIRMED` potwierdzony zestaw ograniczeń. Postęp planowania przechowuje osobna encja `WorkflowRuns`, powiązana jeden-do-jednego z `TripRequest`. Rekord workflow zawiera bieżący stan, kontrolowane informacje o błędzie i znaczniki czasu. Projekcja OData workflow jest tylko do odczytu; klient nie może ominąć maszyny stanów przez bezpośredni zapis. Dzięki temu etap wykonania nie zmienia znaczenia statusu briefu ani zasad jego edycji.

Każde deterministyczne wykonanie ma osobny `PlanningRun`, powiązany z `TripRequest` i
`WorkflowRun`. Każdy nowy run zapisuje `planning-request-fingerprint-v2` pełnego wejścia,
dokładną wersję kontraktu walut i ceny oferty, kanoniczny provider manifest z jego SHA-256, wersję silnika i
scoringu, liczniki kandydatów oraz kontrolowany status. Manifest opisuje dokładnie jedną
konfigurację dla każdej roli `TRANSPORT`, `ACCOMMODATION` i `PLACES`, wraz z trybem
`FIXTURE`/`LIVE`, wersjami providera/adaptera/upstream schema oraz polityką wykonania.
Run utrwala także dokładny `providerExecutionCallCount`; replay wymaga całej sekwencji audytu,
nie tylko poprawnego prefiksu. Unikalność fingerprintu zapewnia idempotencję dla
nieedytowalnego, potwierdzonego briefu.

Replay stosuje multi-read/single-write. Najpierw szuka v2. Po jego braku zamrożony exact v1 z
`main@ad7a909` obsługuje sukces przy `OPTIONS_READY` oraz historyczny niedobór przy
`CONSTRAINTS_CONFIRMED`; exact v0 z `main@1b8a852` pozostaje success-only. Historyczny run jest
zwracany tylko po fail-closed sprawdzeniu statusu,
linkage, wersji, liczników i dokładnie trzech spójnych `RankedOptions`. Odczyt v1/v0 jest
ponadto dostępny wyłącznie dla manifestu identycznego z zamkniętym manifestem fixture; live
ani konfiguracja mieszana nie mogą odziedziczyć wyniku fixture. Nie ma UPDATE, backfillu,
migracji ani provider call. Każda niespójność kończy się 409 `PLANNING_STATE_INCONSISTENT`.

Równoległe wywołania `startPlanning` dla tego samego briefu są koaleskowane przez serwis do
jednego aktywnego wykonania. Pierwszy request jest właścicielem transakcji, a kolejne czekają
na jego commit i otrzymują ten sam wynik. Wpis single-flight jest usuwany dopiero w fazie
`done` requestu; unikalność fingerprintu w bazie nadal chroni trwały zapis przed duplikatami.

## Maszyna stanów

Dozwolone przejścia są zapisane w czystej funkcji domenowej, niezależnej od CAP i bazy danych:

- `COLLECTING` → `NEEDS_CLARIFICATION` → `CONSTRAINTS_CONFIRMED`;
- `COLLECTING` → `CONSTRAINTS_CONFIRMED`;
- `CONSTRAINTS_CONFIRMED` → `SEARCHING` → `CANDIDATES_VALIDATED` → `OPTIONS_READY`;
- `OPTIONS_READY` → `OPTION_SELECTED` → `ITINERARY_GENERATED` → `VALIDATED` → `READY`;
- `READY` → `REVISING` → `ITINERARY_GENERATED`.

Niedozwolone przejście zgłasza `DomainError` z kodem, stanem źródłowym, stanem docelowym i czytelnym komunikatem. Funkcja zwraca nowy stan dopiero po sprawdzeniu reguły, dlatego błąd nie powoduje częściowej zmiany. `startPlanning` wykonuje pierwsze trzy przejścia planowania w jednej transakcji i utrwala ich kolejność w `WorkflowTransitions`.

Akcja `confirmConstraints` waliduje podstawowy brief i oba profile, wymaga statusu `DRAFT`, a następnie w jednej transakcji ustawia status briefu oraz tworzy albo aktualizuje powiązany `WorkflowRun` do `CONSTRAINTS_CONFIRMED`. Błąd w dowolnym kroku wycofuje całą operację. Ponowne potwierdzenie pozostaje niedozwolone.

Akcja `startPlanning` ponownie waliduje cały brief i profile, tworzy kontekst w integer
minor units, wiąże wykonanie z provider manifestem, wywołuje providery przez ograniczony
run-scoped execution scope i uruchamia pipeline. Providerzy są wywoływani przed pierwszym
zapisem. Udany wynik zapisuje atomowo run, przejścia, dokładnie trzy opcje, budżety, źródła,
disclosures opłat, bezpieczny audit wykonania, notatki i odrzucenia. Awaria providera zwraca
kontrolowane `PROVIDER_SEARCH_FAILED`, anuluje sibling calls i pozostawia workflow w
`CONSTRAINTS_CONFIRMED` bez wyników. Zaakceptowany replay v2, exact v1 albo exact v0 kończy
się przed konstrukcją providerów i nie wykonuje żadnego zapisu.

Phase 4B0 nie zmienia topologii transakcji requestu CAP: odczyt i provider fan-out nadal
odbywają się po utworzeniu `cds.tx(request)`, choć przed pierwszym zapisem. Docelowe krótkie
read → network bez otwartej transakcji → krótkie write z ponowną walidacją stanu i
idempotencji należy do 4B1.

## Deterministyczny silnik kandydatów

Faza 2B wprowadza trzy interfejsy graniczne: `TransportProvider`,
`AccommodationProvider` i `PlacesProvider`. Requests zawierają wyłącznie jawny kontekst
podróży, a wyniki używają typów domenowych. Kod domenowy i ranking nie znają schematu
żadnego konkretnego API. Obecne implementacje mock korzystają wyłącznie z
wersjonowanych fixture'ów generowanych względem dat briefu, dlatego nie zależą od
internetu ani zegara systemowego.

Phase 4B0 dodaje `planning-provider-manifest-v1` i
`provider-execution-policy-v1`. Domyślna polityka ogranicza run do 25 rzeczywistych
source/upstream calls, timeoutu
10 000 ms, concurrency 4 i jednego attemptu. Kolejka jest FIFO, rate limit działa
fail-fast, a fallback ma stałą wartość `NONE`; konfiguracja może te limity tylko obniżyć.
Adapter live wykonuje każdy create/poll/page/fan-out request przez run-scoped executor, więc
requesty wewnątrz jednego logicznego `search()` dzielą ten sam budżet i concurrency. Pierwszy
błąd anuluje sibling calls. Zamknięte błędy i wewnętrzne eventy audytowe zawierają
wyłącznie bezpieczne metadata i fingerprinty, nigdy raw request/response/error ani headers.
Manifest live lub mieszany nie uruchamia legacy fixture replay.
Instancja adaptera live musi przed fan-outem potwierdzić dokładną tożsamość z manifestu, także
dla pustego wyniku; źródła wybranych fixture są związane z faktycznie wykonanym query.

Kwoty są dyskryminowaną unią `Money`: znane ceny przechowują bezpieczną całkowitą
liczbę minor units, natomiast `UNKNOWN` ma `amountMinor: null`. Każda cena ma
`PriceType` i `source-snapshot-v2` z jawnym typem `LIVE`, `FIXTURE` albo
`INTERNAL_RULE`, wersjami adaptera/providera, kanonicznym query/result fingerprintem,
opcjonalnym expiry, nullable URL/attribution/currency i wymaganą wersją terms policy. Reguły
kosztów lokalnych są estymacjami z własnym wersjonowanym
snapshotem `INTERNAL_RULE`. Silnik nie wykonuje przewalutowania; inna waluta powoduje
odrzucenie kandydata.

`offer-price-v2` zachowuje `price` jako obowiązkowy subtotal i `additionalFees` jako
obowiązkowe podatki/opłaty, a dodatkowo wymaga zgodnego `mandatoryTotal`. Nieznana wymagana
wartość nadal odrzuca kandydata. Warunkowe opłaty zachowują label, condition, payable-at i
mandatory-when-met, a opcjonalne ancillary własny label. Obie kolekcje mają osobne stany
kompletności `COMPLETE`/`PARTIAL`/`UNKNOWN` i są utrwalanymi disclosures, ale nie są
dodawane do siedmiu kategorii budżetu, bufora, score ani hard constraints.

Candidate builder tworzy wariant z destynacji, transportu, noclegu i kosztów lokalnych.
Konfigurowalne limity liczby transportów, noclegów oraz kandydatów na destynację
zapobiegają nieograniczonemu iloczynowi kartezjańskiemu. Następnie filtr zbiera wszystkie
powody odrzucenia, w tym naruszenia godzin, czasu podróży, środka transportu, budżetu,
źródeł, waluty, kompletności i duplikacji. Niewykonalny kandydat nigdy nie trafia do
scoringu.

Domyślna wersja `candidate-engine-v1` ogranicza fan-out do 12 destynacji, 6 transportów,
6 noclegów, 20 miejsc oraz 24 kandydatów na destynację. Limity można obniżyć jawną
konfiguracją i są walidowane jako nieujemne, bezpieczne liczby całkowite. Minimalny
efektywny czas na miejscu wynosi 24 godziny. `maxTravelMinutes` jest interpretowane jako
limit każdego odcinka podróży osobno, czyli dłuższego z przejazdu w obie strony. Gdy
constraint nie jest podany, filtr nie wprowadza ukrytego limitu; domyślne 12 godzin
służy wyłącznie do normalizacji komponentu scoringowego `travelTime`.

Zamknięty katalog powodów odrzucenia obejmuje:

- `BUDGET_EXCEEDED`, `DEPARTURE_TOO_EARLY`, `RETURN_TOO_LATE`;
- `TOO_MANY_CONNECTIONS`, `TRANSPORT_MODE_NOT_ALLOWED`, `TRAVEL_TIME_EXCEEDED`;
- `REQUIRED_PRICE_UNKNOWN`, `SOURCE_MISSING`, `CURRENCY_MISMATCH`;
- `DUPLICATE_CANDIDATE`, `INSUFFICIENT_TIME_AT_DESTINATION`, `INVALID_DATES`,
  `INCOMPLETE_DATA`.

Kalkulator `internal-cost-estimates-v1` używa stawek w minor units na osobę i dzień:
2 000 na transport lokalny, 8 000 na wyżywienie i 4 000 na atrakcje. Dzień wyjazdu i
powrotu są wliczone. Bufor wynosi 10% znanego podsumowania i jest zaokrąglany w górę do
pełnego minor unit. `BudgetBreakdown` osobno sumuje kwoty potwierdzone i estymowane, a każda
kategoria zachowuje obie części. Dzięki temu legalne połączenie potwierdzonej i estymowanej
opłaty dodatkowej pozostaje odtwarzalne po agregacji do jednego `BudgetItem`. Jeśli dowolna
wymagana kategoria jest `UNKNOWN` albo ma inną walutę, koszt całkowity, koszt na osobę i
pozostały budżet mają wartość `null`.

Score ma zakres 0–100 i wersję zapisaną w kodzie. Jest ważoną średnią komponentów:
`budgetFit` 20%, `travelTime` 15%, `effectiveTimeAtDestination` 15%,
`accommodationLocation` 15%, `dataCompleteness` 10%, `priceConfidence` 10% oraz
`deterministicPreferenceFit` 15%. Stabilny tie-breaker zapewnia identyczną kolejność
przy ponownym uruchomieniu. Diversity selection przypisuje role `BEST_OVERALL`,
`MOST_CONVENIENT` i `BEST_VALUE`, preferuje różne destynacje i nigdy nie powtarza tej
samej kombinacji transportu z hotelem. Przy mniej niż trzech poprawnych kandydatach
zwraca jawny niedobór bez poluzowania constraints.

Komponenty są jawnie obliczane następująco, zawsze z ograniczeniem do 0–100:

- `budgetFit = (1 - total / budgetLimit) × 100`;
- `travelTime = (1 - longestLeg / maxTravelMinutes) × 100`;
- `effectiveTimeAtDestination = effectiveMinutes / requestedWindowMinutes × 100`;
- `accommodationLocation` pochodzi z ugruntowanego `centralityScore` noclegu;
- `dataCompleteness` jest udziałem spełnionych kontroli kompletności;
- `priceConfidence = (confirmed + 0,7 × estimated) / total × 100`;
- `deterministicPreferenceFit` jest średnią dopasowań ważoną wagami 1–5 z briefu.

`BEST_OVERALL` używa całkowitego score. `MOST_CONVENIENT` porządkuje pozostałe
kandydatury według `0,40 × travelTime + 0,35 × effectiveTimeAtDestination + 0,25 ×
accommodationLocation`, a `BEST_VALUE` według `0,65 × budgetFit + 0,35 ×
priceConfidence`. Każda kolejna rola najpierw szuka niewykorzystanej destynacji i zawsze
odrzuca wykorzystaną już semantyczną kombinację transportu z hotelem.

Fixture `europe-reference-v1` zawiera 8 destynacji, 16 transportów, 11 noclegów i 12
miejsc. Dla referencyjnego briefu daje 28 kandydatów: 6 poprawnych i 22 jawnie
odrzucone. Stabilny wybór to Praga jako `BEST_OVERALL`, Wiedeń jako
`MOST_CONVENIENT` i Budapeszt jako `BEST_VALUE`.

Faza 2C integruje ten sam czysty pipeline z CAP i UI bez zmiany zasad rankingu. Surowe
payloady providerów nie są zapisywane. `RankedOptions` zawierają wyłącznie wybrane fakty
domenowe i komponenty score; `BudgetItems` zachowują kategorię, price type, klasyfikację
oraz części confirmed/estimated;
`SourceSnapshots` przechowują kontrolowany kontrakt pochodzenia. `OfferChargeCollections` i
`OfferChargeDisclosures` zachowują nieaddytywne opłaty oraz ich kompletność, a wewnętrzne
`ProviderExecutionRecords` — zamknięty audit bez payloadów. `OptionNotes` powstają z
deterministycznych szablonów. Legacy `providerFixtureVersion` pozostaje tylko aliasem dla
jednorodnego manifestu fixture; dla konfiguracji live/mieszanej jest `null`. Istniejący
`grounded-option-context-v1` nie otrzymuje w 4B0 cichego rozszerzenia na live i może odrzucić
taki przyszły run fail-closed.

Przy mniej niż trzech poprawnych wariantach zapisuje się `PlanningRun` ze statusem
`INSUFFICIENT_OPTIONS`, diagnostyki `RejectionReasons` i `RejectionSummaries`, ale zero
`RankedOptions`. `WorkflowRun` pozostaje w `CONSTRAINTS_CONFIRMED`. Ponowne wywołanie dla
tego samego fingerprintu zwraca ten sam run i nie tworzy duplikatów.

UI pozwala poprawić zapisany `DRAFT` przez PATCH przed potwierdzeniem. Po kontrolowanym
niedoborze użytkownik może utworzyć nowy, edytowalny brief skopiowany z obecnych danych;
potwierdzony brief i jego diagnostyka pozostają niezmienne. Widok jawnie opisuje fixture
Fazy 2 jako demonstracyjny scenariusz rozpoczynający się we Wrocławiu, bez aktualnych ofert
ani potwierdzonej dostępności.

## Publiczny kontrakt CAP

Bound actions na `TripRequests`:

- `confirmConstraints()` — zatwierdza brief;
- `startPlanning()` — zwraca wersjonowany `PlanningRun`.

Bound action na `RankedOptions`:

- `generateNarrative()` — po jawnym opt-in uruchamia profil `GENERATE` dla jednej już
  wybranej opcji i zwraca `NarrativeRun`.

Projekcje tylko do odczytu: `WorkflowRuns`, `PlanningRuns`, `WorkflowTransitions`,
`RankedOptions`, `BudgetBreakdowns`, `BudgetItems`, `SourceSnapshots`,
`OfferChargeCollections`, `OfferChargeDisclosures`, `OptionNotes`, `RejectionReasons` i
`RejectionSummaries`. Klient pobiera zbiory filtrem po `tripRequest_ID` albo
`planningRun_ID`; nie może bezpośrednio zmienić workflow ani wyników. Wewnętrzne
`ProviderExecutionRecords` nie są publikowane przez serwis.

`NarrativeRuns`, `OptionNarratives` i `NarrativeFactReferences` są projekcjami tylko do
odczytu i zachowują publiczny kontrakt 3B2: `NarrativeRuns` pokazuje historyczny generate
`aiRunId` oraz dotychczasowe bezpieczne wersje, a rekordy potomne dziedziczą linkage przez
`NarrativeRuns`. Wewnętrzny rekord persistence `db.NarrativeRuns` otrzymuje addytywne,
nullable/no-default scalar review/judge IDs i quality versions dla nowych wierszy 3B3, ale
te pola nie rozszerzają publicznej projekcji w tej fazie. Serwis nie publikuje `AiRuns`,
`NarrativeReviewRuns` ani `NarrativeReviewFindings`.

## Deterministyczny rdzeń i AI execution

Kod pozostaje jedynym źródłem prawdy dla constraints, przejść workflow, wykonalności,
scoringu, arytmetyki finansowej i decyzji publikacyjnej narracji. `startPlanning` ani UI nie
wykonują AI. Jedyna akcja CAP Fazy 3B3 pracuje na jawnych, wersjonowanych kontraktach dla
pojedynczej, wcześniej wybranej opcji.

`AiGateway` wybiera pełny profil `DECIDE`, `GENERATE` lub `JUDGE`. Request produktu nie ma
provider override i może jedynie obniżyć task-specific limit tokenów. Brak adaptera,
wyłączony gateway lub błąd dostawcy kończą się kontrolowanym błędem; nie ma cichego
fallbacku między providerami ani modelami.

Zmiana `AI_<TASK>_PROVIDER` względem defaultu wymaga jawnego `AI_<TASK>_MODEL`; default ani
legacy alias innego providera nie może utworzyć przypadkowej pary provider/model.

Adapter OpenAI używa Responses API oraz structured outputs. Adapter Anthropic używa
Messages API i structured outputs. Oba korzystają z oficjalnych SDK, ale typy SDK nie
przechodzą poza warstwę adaptera. Wynik jest ponownie walidowany lokalnie przez Zod, nawet
gdy provider deklaruje zgodność ze schematem. Klient SDK powstaje leniwie dopiero przy
wywołaniu, dlatego import, build, testy i standardowy start nie wymagają kluczy.

Adapter nie przechowuje modelu; otrzymuje profil per call. Wynik rozróżnia
`configuredModel` z profilu i `responseModel` od providera, a gateway waliduje wszystkie
metadane przed użyciem outputu.

Asynchroniczny recorder działa fail-closed. Trwały `STARTED` powstaje przed requestem do
providera, a `SUCCEEDED` lub `FAILED` aktualizuje dokładnie ten sam UUID w krótkiej,
niezależnej transakcji CAP. Brak zapisu blokuje wykonanie albo zwrot wyniku i kończy się
`AI_AUDIT_FAILED`.

Próba `GENERATE`/`JUDGE` przed durable `STARTED` nie ma prawdziwego UUID, nie tworzy review
ani produktu i nie wywołuje providera. Niezależny sink otrzymuje dokładnie jeden zamknięty
`AI_PRE_START_FAILURE` bez `aiRunId`, raw danych lub błędu; nie fabrykujemy audytu.

Recorder jest obowiązkową zależnością `AiGateway`; jawna factory persistent składa oba
adaptery, `PersistentAiRunRecorder` i `CapAiRunStore`. Test CAP + SQLite wykazał circular
wait, gdy niezależny audit był uruchamiany po rozpoczęciu requestowej transakcji DB.
Store odrzuca taki układ przed adapterem. Use case 3B3 kończy krótki odczyt, wykonuje
osobne `STARTED → adapter → terminalny audit` dla `GENERATE` i — po lokalnym prechecku —
`JUDGE`, bez otwartej transakcji DB. Dopiero potem otwiera osobny krótki zapis produktu.
Test potwierdza committed `STARTED` przed adapterem oraz przetrwanie terminalnego audytu po
rollbacku późniejszego zapisu produktu.

Wewnętrzne `AiRuns` przechowuje provider/task, oba modele, wersje, fingerprint, timestamps,
skonfigurowany effort, skonfigurowany i efektywny limit output tokens, usage, latency,
attempts, refusal i kontrolowany błąd. Nie zapisuje promptów, wejść, wyjść, raw responses,
raw errors, nagłówków ani sekretów i nie jest publikowane w `TripPlannerService`. Domyślny
`expiresAt` wynosi 30 dni. Cleanup ma kontrakt
`deleteExpired(now)`, ale nie ma schedulera. `AiRuns` jest efemerycznym audytem. Narracje są
danymi produktu i po dokładnej walidacji terminalnego audytu przechowują tylko scalar UUID,
bez foreign key blokującego cleanup. Test CAP/SQLite potwierdza usunięcie wygasłego `AiRun`
oraz dalszą spójność i czytelność narracji.

### Grounded option narratives

Krótki root transaction odczytuje udany `PlanningRun`, jedną `RankedOption`, jej
`BudgetItems` i `SourceSnapshots`, po czym kończy się przed AI. Kontekst
`grounded-option-context-v1` stabilnie sortuje fakty i tworzy fingerprint canonical JSON.
Każdy fakt, w tym jawny `UNKNOWN` lub `MISSING`, otrzymuje deterministyczny
`fact_<sha256>` związany z wersją i dokładnym fingerprintem. Transport i nocleg wskazują
dokładne `SourceSnapshot` znalezione przez persisted source contexts; dangling lub
wieloznaczne mapowanie jest odrzucane. Selection, score i agregaty budżetu są oznaczone jako
wersjonowane derivations `INTERNAL_DETERMINISTIC`.

Minor units pozostają źródłem prawdy. `grounded-money-display-v1` przygotowuje w kodzie
human-readable wartości limitu, total, confirmed, estimated, per-person i remaining.
Precision pochodzi wyłącznie z wersji kontraktu zapisanej na `PlanningRuns`; obecny
`currency-fraction-digits-v1` przy `Decimal(13, 2)` dopuszcza PLN/EUR i odrzuca
JPY/KWD/nieznane kody. Brakująca lub nieobsługiwana wersja historyczna nie jest zastępowana
stałą runtime. Kategorie, ich części confirmed/estimated, klasyfikacje, waluta, partial sums,
total, per-person, remaining i status kompletności muszą być wzajemnie zgodne.
`providerFixtureVersion` i `scoringVersion` muszą zgadzać się na PlanningRun,
RankedOption, BudgetItems i SourceSnapshots. Każda sprzeczność odrzuca cały kontekst przed AI.
`UNKNOWN` i `MISSING` nie dostają wymyślonej kwoty. Prompt
zabrania modelowi dzielenia minor units, ustalania precision i formatowania pieniędzy.

Kolumny `PlanningRuns.currencyContractVersion` oraz części `BudgetItems` są addytywne,
nullable i nie mają defaultu. Nowe runy wypełniają je zawsze, natomiast wiersze legacy
pozostają nieoznaczone. Exact v0 może być odczytany jedynie przez ograniczony replay
`startPlanning`, lecz przy budowie grounded context nadal jest odrzucany fail-closed przed
gatewayem i `AiRun`; kod nie wykonuje nieudowodnionego backfillu.

`grounded-option-narrative-prompt-v3` używa wyłącznie profilu `GENERATE` i exact
`narrative-generation-view-v1`, wyprowadzonego z lokalnego `narrative-model-view-v1`.
Provider schema v2 zawiera tylko maksymalnie sześć bloków i nie pozwala zwrócić fingerprintu
ani mandatory disclosures. Generation view jest zamkniętą projekcją exact fact keys i value
shapes: dodatkowe/nieznane pola failują, source metadata nie ma ścieżki do provider inputu, a
niezależny fact value, object key, fact ID lub fingerprint nie jest skanowany pod kątem
przypadkowej zgodności z source string. Lokalny binder odrzuca pusty, nieznany, restricted lub
obcy fact ID, wstrzykuje exact context fingerprint i dokłada code-owned provenance oraz
`UNKNOWN`/`MISSING` risk blocks do limitu ośmiu. Niczego nie filtruje częściowo ani nie
przepisuje provider prose. Referencja zapewnia traceability, ale bez `JUDGE` nie jest jeszcze
semantycznym dowodem zgodności tekstu z faktem.

Po trwałym `SUCCEEDED` gatewaya writer jeszcze raz sprawdza istnienie audytu, terminalny
status oraz exact planning run/task/prompt/schema/input fingerprint. Osobna transakcja
zapisuje `NarrativeRuns`, bloki `OptionNarratives` i znormalizowane
`NarrativeFactReferences`. `NarrativeRuns.aiRunId` jest niezmiennym historycznym scalarem;
potomkowie nie duplikują powiązania. Awaria AI, audytu, walidacji albo zapisu nie zmienia
deterministycznych opcji. Rollback product write nie usuwa audytu, a cleanup audytu nie
usuwa danych produktu.

### Narrative quality gate Fazy 3B3

Po zbudowaniu pełnego `GroundedOptionContext` kod tworzy lokalny `narrative-model-view-v1`,
a dla GENERATE dodatkowo `narrative-generation-view-v1`. Generation view zachowuje wyłącznie
referencjonowalne fakty `KNOWN`, display values, `factId` i safe rank/role. Nie zawiera
provenance, `UNKNOWN`/`MISSING`, raw `sourceUrl`, provider/source identity, external IDs,
source keys, contexts, HTML, znaków kontrolnych ani zbędnych provider-shaped wartości. Ma
własny canonical SHA-256 i limit rozmiaru; pełny model/context pozostaje lokalny i trafia do
quality boundary JUDGE.

Po `GENERATE` lokalny finalizer wiąże provider blocks z exact generation view, wstrzykuje
grounded fingerprint i dokłada exact mandatory disclosures. Non-`KNOWN` koszt rezerwuje dla
kodu wyłącznie nieznaną wartość/status, nie cały obiekt domenowy: cytowany `KNOWN` transport,
hotel lub destination pozostaje narratable, dopóki tekst nie przypisuje kosztu, kwoty,
`free`/`included`, potwierdzenia ceny albo dostępności. Następnie deterministyczny
precheck sprawdza finalization oraz blokuje URL-e, Markdown/HTML,
script/event handlers, kontrolne lub bidi znaki, wartości wykluczone przez projection i
mechanicznie rozpoznawalny niedozwolony reformat pieniędzy. Odrzucenie na tym etapie
wykonuje zero `JUDGE` calls. Semantic amount mismatch, nowe obliczenie i wypełnienie
`UNKNOWN` dochodzą do `JUDGE` zgodnie z frozen stage labels; szersza interpretacja reguły
exact-money pozostaje jawnym punktem review.

Kod buduje osobny `narrative-quality-context-v2`: dokładny zwalidowany kandydat i jego
fingerprint, model view i grounded fingerprints, potwierdzone strukturalne constraints oraz
wersje wszystkich kontraktów. Nie mutuje to `grounded-option-context-v1`. Profil `JUDGE`
otrzymuje pełny golden-compatible rubric contract, exact version/fingerprint oraz quality i
narrative context. Provider zwraca tylko findings z jawnym dimension, zamkniętym kodem,
severity, block sequences i in-context fact IDs. Nie zwraca fingerprintów, osobnej tablicy
statuses, overall verdict ani persistowalnego rationale. Kod wstrzykuje fingerprinty,
wyprowadza statuses i publikuje tylko przy zerze findings.

`NarrativeReviewRuns` i znormalizowane `NarrativeReviewFindings` przechowują wyłącznie
kontrolowane metadata, fingerprints, wersje, wyniki wymiarów i scalar IDs audytów. Precheck
lub semantic reject jest zapisywany w osobnej krótkiej transakcji i pozostawia zero tekstu
kandydata oraz zero rekordów produktu narracji. `PUBLISH` atomowo zapisuje review i dokładny
tekst oceniony przez judge dopiero po terminalnych `SUCCEEDED` obu audytów. Nullable pola
quality/review na legacy narracjach 3B2 nie mają defaultu ani backfillu.

Synthetic dataset v2 (z retained v1), runtime/frozen schema parity, deterministic contract replay, metryki i
privacy-safe report są deterministyczne i credential-free. Replay kopiuje expected labels do
actual i jawnie nie mierzy jakości modelu. Live E2E wykonuje niezależne deterministic
`requiredProperties`; jego bundle-linkage evidence jest nazwane in-memory, podczas gdy
osobny test produkcyjnych writerów dowodzi zapisu CAP/SQLite. Live baseline jest osobną
ścieżką: default `AI_LIVE_EVAL_ENABLED=false`, preflight wymaga znanych cen, credentiali i
jawnych opt-inów, a guard rezerwuje koszt przed każdym wywołaniem i egzekwuje maksymalnie 48
logicznych calls, 56 attempts i USD 3.00. Czysty `npm run eval:live:preflight` współdzieli
plan i cost estimator, ale nie importuje ścieżki wykonawczej i działa bez opt-inów,
credentiali, bazy lub sieci. Pierwszym runtime scenario jest exact Luna/low/2048; canonical
ceiling wynosi 1,171,326 USD micros, a kodowo wyliczony zapas do capu 1,828,674 micros. Exact
Terra/2048 ma ceiling 8,595,433 micros i pozostaje wyłącznie comparison scenario ponad capem,
nie fallbackiem. Trzy osobno
autoryzowane runy zatrzymały się fail-closed przed raportem jakości i nie były ponawiane.
Transport JUDGE v3 zachowuje metadata przed parserami, zawiera wyłącznie findings i rozdziela
statyczny schema od exact lokalnych bindingów; syntetyczny runner może raportować kompletnie
rozliczony invalid jako
`FAIL`, ale produkt i accepted manifest pozostają fail-closed. Ten offline fix wykonuje zero
provider calls, nie autoryzuje kolejnego baseline i pozostawia Fazę 3B3 w `REVIEW` do osobnej
zgody oraz przejścia wszystkich bramek.

Post-response taxonomy jawnie rozdziela malformed raw provider transport
(`TRANSPORT_SCHEMA_VALIDATION`), exact request/generation/context/local-injection mismatch
(`CONTEXT_BINDING`) oraz provider-valid output odrzucony przez deterministic narrative policy
(`NARRATIVE_FINALIZATION`). Allowlistowana/persistowana zmiana stage contractu bumpuje wyłącznie
`post-response-failure-accounting-v3` do `post-response-failure-accounting-v4`; draft report v3
i live-execution v3 zachowują identyfikatory, ponieważ ich zamierzone kontrakty v3 są aktualizowane
spójnie przed merge.

## Stos technologiczny

Wersje zostały dobrane dla Node.js 24: CAP 10 oficjalnie rekomenduje Node 24, przechodzi na ESM i Vitest, a Playwright wspiera bieżące linie Node 22/24/26. Używamy TypeScript 6, ponieważ jest najnowszą linią zgodną z zakresem peer dependency bieżącego `typescript-eslint`; TypeScript 7 został świadomie odrzucony zamiast omijania konfliktu. npm 11 zachowuje zgodność z lokalnym Node 24.13. Dokładne wersje są przypięte w `package.json` i `package-lock.json`.
