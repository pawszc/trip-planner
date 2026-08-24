# ADR 0006: Task-aware AI execution profiles i trwałe rekordy audytowe

- Status: zaakceptowane
- Data: 2026-08-12

## Kontekst

Faza 3A dodała vendor-neutral gateway i adaptery OpenAI/Anthropic, ale przypisywała model
do konfiguracji providera i pozwalała requestowi wybrać provider. Przed pierwszym
wywołaniem LLM przez produkt potrzebujemy kontrolowanego kontraktu kosztu i jakości dla
każdego zadania oraz trwałego audytu, który nie zapisuje danych wejściowych ani odpowiedzi.

Swobodny per-request provider override osłabiałby przewidywalny routing, przyszłe limity
kosztów i możliwość wyjaśnienia, dlaczego dane zadanie użyło konkretnego modelu. Synchroniczny
recorder typu `void` nie mógł zagwarantować, że wykonanie ma trwały ślad przed requestem
sieciowym. Jedno pole `model` nie rozróżniało ustawienia kontrolowanego przez aplikację od
identyfikatora lub snapshotu zwróconego przez providera.

## Decyzja

### Profile zadań

Routing jest task-aware. Konfiguracja zawiera osobny `AiExecutionProfile` dla `DECIDE`,
`GENERATE` i `JUDGE`; każdy profil ma `provider`, `model`, `effort` i
`maxOutputTokens`. Domyślne profile to:

| Zadanie    | Provider  | Model             | Effort | Max output tokens |
| ---------- | --------- | ----------------- | ------ | ----------------: |
| `DECIDE`   | OpenAI    | `gpt-5.6-luna`    | `none` |               512 |
| `GENERATE` | Anthropic | `claude-sonnet-5` | `low`  |              1600 |
| `JUDGE`    | OpenAI    | `gpt-5.6-luna`    | `low`  |              2048 |

Faza 3B3 przypina ten profil JUDGE przez `narrative-quality-model-profile-v2`. Limit 2048 jest
wspólnym budżetem reasoning i visible structured output; nie wprowadza retry, continuation,
resume ani fallbacku modelu.

Normalny `StructuredAiRequest` nie ma provider override i nie może zmienić modelu ani
effort. Opcjonalny limit requestu może tylko obniżyć limit profilu. Testy wstrzykują
konfigurację, zamiast modyfikować routing pojedynczego requestu. Operator-only live smoke
pozostaje osobną ścieżką: deterministycznie wybiera pierwszy profil używający wskazanego
providera w kolejności `DECIDE`, `GENERATE`, `JUDGE` i ogranicza limit do 128.

Adapter przechowuje wyłącznie tożsamość providera. Profil jest przekazywany per call, a
adapter sprawdza zgodność `profile.provider` ze swoim providerem. Credentiale, timeout i
retry pozostają ustawieniami provider/runtime, nie profilu zadania.

Jawna zmiana `AI_<TASK>_PROVIDER` względem domyślnego providera zadania wymaga jednocześnie
jawnego, niepustego `AI_<TASK>_MODEL`. Loader odrzuca brak modelu przed requestem sieciowym
jako `INVALID_AI_CONFIGURATION` ze wskazaniem pola modelu. Nie dobiera modelu dla nowego
providera i nie pozwala, aby alias legacy poprzedniego providera spełnił to wymaganie.

### Configured model i response model

Wynik wykonania oraz telemetria rozdzielają:

- `configuredModel` — dokładny model z profilu zadania;
- `responseModel` — niepusty identyfikator zwrócony przez providera, który może być
  dokładniejszym snapshotem.

Sama różnica tekstowa nie jest błędem. Gateway waliduje natomiast provider, configured
model, typ zadania, wersje promptu i schematu, fingerprint, `aiRunId` oraz obecność
`responseModel`. Niespójny wynik nie jest zwracany.

### Asynchroniczny audyt fail-closed

`AiRunRecorder.record` zwraca `Promise<void>`. Każde wykonanie otrzymuje UUID `aiRunId` i
przechodzi lifecycle:

1. `STARTED` jest utrwalany przed wywołaniem adaptera;
2. `SUCCEEDED` kończy ten sam rekord dopiero po lokalnej walidacji wyniku i metadanych;
3. `FAILED` kończy ten sam rekord po znormalizowanym błędzie adaptera.

Polityka jest fail-closed i nie ma flagi fail-open:

- błąd zapisu `STARTED` blokuje adapter;
- błąd zapisu `SUCCEEDED` blokuje zwrot poprawnego outputu;
- błąd zapisu `FAILED` zastępuje pierwotny błąd bezpiecznym `AI_AUDIT_FAILED`; details mogą
  zachować jedynie pierwotny `errorCode`.

`AiGateway` wymaga recordera w konstruktorze. `NoopAiRunRecorder` pozostaje wyłącznie jawną
kompozycją testową/operator-only; normalny gateway nie ma cichego fallbacku. Funkcja
`createPersistentAiGateway` jest jedynym jawnym composition rootem produkcyjnym i składa
gateway, oba adaptery SDK, `PersistentAiRunRecorder` oraz `CapAiRunStore` z retencją profilu.
Samo utworzenie factory nie czyta środowiska, nie łączy się z bazą i nie wykonuje requestu.

### Wewnętrzne AiRuns i retencja

`AiRuns` jest encją wewnętrzną, nieprojektowaną w `TripPlannerService`. ID encji jest tym
samym `aiRunId`. Opcjonalne powiązanie z `PlanningRuns` pozwala zachować smoke/evale bez
planu oraz przyszłe wykonania produktowe z planem.

Rekord przechowuje status, task/provider, oba identyfikatory modelu, wersje, fingerprint,
timestamps, użycie tokenów, latency, attempts, provider request ID, refusal oraz
kontrolowany kod błędu i retryability. Nie przechowuje instrukcji, promptu, wejścia,
outputu, surowej odpowiedzi, surowego błędu, nagłówków ani credentiali.

Domyślna retencja wynosi 30 dni, walidowany zakres to 1–365 dni, a `expiresAt` powstaje przy
`STARTED`. Store udostępnia `deleteExpired(now)`, które usuwa tylko rekordy z
`expiresAt < now`. Faza 3B1 świadomie nie dodaje schedulera; cleanup musi zostać podłączony
przez deployment lub kolejną fazę operacyjną.

Od Fazy 3B2 `AiRuns` jest jawnie traktowane jako efemeryczne metadata audytowe. Dane produktu
nie tworzą mandatory association ani foreign key blokującego cleanup. Po sprawdzeniu
istniejącego terminalnego `SUCCEEDED` i dokładnych pól linkage `NarrativeRuns` zachowuje
jedynie historyczny scalar UUID `aiRunId`; bloki i fact references dziedziczą go przez
`NarrativeRuns`. Domyślne 30 dni i konfigurowalny zakres retencji pozostają bez zmian.

Każdy INSERT/UPDATE/DELETE store działa w krótkiej, jawnej transakcji CAP. Realny test
kompozycji CAP request handler + SQLite in-memory wykazał jednak, że poprzednie założenie o
możliwości rozpoczęcia takiej transakcji z aktywnej transakcji bazodanowej requestu było
błędne: SQLite używa domyślnie jednego połączenia, więc store czekał na połączenie trzymane
przez outer request, a outer request czekał na store. Powstawał circular wait i test musiał
zostać zatrzymany po twardym timeout.

`CapAiRunStore` wykrywa teraz rozpoczętą transakcję DB w bieżącym kontekście CAP i odrzuca
operację fail-closed przed próbą zdobycia drugiego połączenia. Produktowy use case AI musi
stosować fazową granicę wykonania:

1. krótka, jawna transakcja odczytu produktu kończy się przed gatewayem;
2. niezależny `STARTED` zostaje utrwalony;
3. adapter działa bez otwartej transakcji DB;
4. niezależny `SUCCEEDED` albo `FAILED` zostaje utrwalony;
5. dopiero potem osobna krótka transakcja zapisuje wynik produktowy.

Test-only CAP service potwierdza tę granicę na SQLite: niezależny odczyt w momencie wejścia
do mock adaptera widzi już committed `STARTED`, po powrocie istnieje dokładnie jeden
`SUCCEEDED`, a celowy rollback późniejszego product write nie usuwa terminalnego `AiRuns`.
Żadna transakcja bazodanowa nie pozostaje otwarta podczas requestu do modelu.

## Migracja konfiguracji 3A

Nowe nazwy `AI_<TASK>_MODEL` i `AI_<TASK>_EFFORT` mają pierwszeństwo. Do końca Fazy 3B
loader akceptuje wyłącznie dwa ograniczone zestawy deprecated aliases:

- `OPENAI_DECIDE_MODEL` i `OPENAI_REASONING_EFFORT` tylko gdy `DECIDE` używa OpenAI;
- `ANTHROPIC_GENERATE_MODEL` i `ANTHROPIC_EFFORT` tylko gdy `GENERATE` używa Anthropic.

Alias modelu obowiązuje tylko dla odpowiadającego mu domyślnego providera. Jeśli provider
zadania został jawnie zmieniony, wyłącznie nowe `AI_<TASK>_MODEL` może dostarczyć model.

Stary globalny `AI_MAX_OUTPUT_TOKENS` nie jest używany. Deprecated aliases zostaną usunięte
po zakończeniu Fazy 3B.

## Konsekwencje

Routing, koszt i jakość są kontrolowane centralnie i audytowalne. Awaria audytu obniża
dostępność, ale zapobiega wykonaniom lub użyciu wyników bez trwałego śladu. Dwa identyfikatory
modelu zwiększają czytelność diagnostyki. Osobne transakcje tworzą dodatkowe krótkie operacje
bazodanowe, ale nie obejmują latency providera.

Persistent gateway nie może zostać wywołany po rozpoczęciu requestowej transakcji DB.
Próba kończy się kontrolowanym `AI_AUDIT_FAILED`, zanim adapter zostanie wywołany. Faza 3B2
musi użyć opisanej granicy fazowej; nie może po prostu dołączyć gatewaya do istniejącej
transakcji `startPlanning`.

Faza 3B1 nadal nie podłącza gatewaya do `startPlanning`, żadnej akcji CAP ani UI. Nie ma
wywołań LLM przez produkt, produkcyjnych promptów ani utrwalania payloadów.

## Odłożone decyzje

- Faza 3B2: grounded option context, schematy i prompty narracji, `OptionNarratives`,
  produktowe wykonanie `GENERATE`, bezpieczne powiązanie z `PlanningRun` oraz zachowanie
  przy kontrolowanej niedostępności narracji.
- Faza 3B3: wykonywanie `JUDGE`, safety pipeline, rubryki i datasety evali, polityka
  publikacji/odrzucenia narracji, rozważenie audytu `effort` oraz configured/effective
  max output tokens, a także płatne evale uruchamiane wyłącznie świadomie.
- Operacje: scheduler lub job wywołujący `deleteExpired(now)`, monitoring backlogu oraz
  ewentualna polityka fail-open wymagają osobnego ADR.
