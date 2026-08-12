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
| `JUDGE`    | OpenAI    | `gpt-5.6-terra`   | `low`  |               768 |

Normalny `StructuredAiRequest` nie ma provider override i nie może zmienić modelu ani
effort. Opcjonalny limit requestu może tylko obniżyć limit profilu. Testy wstrzykują
konfigurację, zamiast modyfikować routing pojedynczego requestu. Operator-only live smoke
pozostaje osobną ścieżką: deterministycznie wybiera pierwszy profil używający wskazanego
providera w kolejności `DECIDE`, `GENERATE`, `JUDGE` i ogranicza limit do 128.

Adapter przechowuje wyłącznie tożsamość providera. Profil jest przekazywany per call, a
adapter sprawdza zgodność `profile.provider` ze swoim providerem. Credentiale, timeout i
retry pozostają ustawieniami provider/runtime, nie profilu zadania.

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

Każdy INSERT/UPDATE/DELETE store działa w krótkiej, jawnej transakcji CAP niezależnej od
transakcji requestu produktu. Żadna transakcja bazodanowa nie pozostaje otwarta podczas
requestu do modelu.

## Migracja konfiguracji 3A

Nowe nazwy `AI_<TASK>_MODEL` i `AI_<TASK>_EFFORT` mają pierwszeństwo. Do końca Fazy 3B
loader akceptuje wyłącznie dwa ograniczone zestawy deprecated aliases:

- `OPENAI_DECIDE_MODEL` i `OPENAI_REASONING_EFFORT` tylko gdy `DECIDE` używa OpenAI;
- `ANTHROPIC_GENERATE_MODEL` i `ANTHROPIC_EFFORT` tylko gdy `GENERATE` używa Anthropic.

Stary globalny `AI_MAX_OUTPUT_TOKENS` nie jest używany. Deprecated aliases zostaną usunięte
po zakończeniu Fazy 3B.

## Konsekwencje

Routing, koszt i jakość są kontrolowane centralnie i audytowalne. Awaria audytu obniża
dostępność, ale zapobiega wykonaniom lub użyciu wyników bez trwałego śladu. Dwa identyfikatory
modelu zwiększają czytelność diagnostyki. Osobne transakcje tworzą dodatkowe krótkie operacje
bazodanowe, ale nie obejmują latency providera.

Faza 3B1 nadal nie podłącza gatewaya do `startPlanning`, żadnej akcji CAP ani UI. Nie ma
wywołań LLM przez produkt, produkcyjnych promptów ani utrwalania payloadów.

## Odłożone decyzje

- Faza 3B2: grounded option context, schematy i prompty narracji, `OptionNarratives`,
  produktowe wykonanie `GENERATE`, bezpieczne powiązanie z `PlanningRun` oraz zachowanie
  przy kontrolowanej niedostępności narracji.
- Faza 3B3: wykonywanie `JUDGE`, safety pipeline, rubryki i datasety evali, polityka
  publikacji/odrzucenia narracji oraz płatne evale uruchamiane wyłącznie świadomie.
- Operacje: scheduler lub job wywołujący `deleteExpired(now)`, monitoring backlogu oraz
  ewentualna polityka fail-open wymagają osobnego ADR.
