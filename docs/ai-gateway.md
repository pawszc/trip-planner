# AI execution i narrative quality gate Fazy 3B3

## Cel i granice

Faza 3B1 dodała task-aware profile wykonania, walidację metadanych adaptera i trwały audyt
`AiRuns`, a Faza 3B2 pierwszą grounded narrative. Faza 3B3 dodaje do tej samej jawnej bound
action `RankedOptions.generateNarrative()` model-safe projection, deterministic precheck,
strict `JUDGE`, code-owned publication policy, bezpieczne review metadata i evale.
`TripRequests.startPlanning()` i UI nadal nie wykonują AI. Gateway jest domyślnie
wyłączony, a standardowe testy są offline i nie potrzebują credentiali.

Kod pozostaje jedynym źródłem prawdy dla hard constraints, kompletności danych, workflow,
rankingu i arytmetyki finansowej. Model nie może uzupełniać brakujących faktów ani liczyć
budżetu.

Contract v2 dodatkowo rozdziela provider transport od finalnego lokalnego outputu. GENERATE
widzi `narrative-generation-view-v1` z samymi dozwolonymi faktami `KNOWN` i zwraca tylko
`{blocks}`. Kod wstrzykuje exact context fingerprint oraz deterministic provenance i
`UNKNOWN`/`MISSING` disclosures. JUDGE zwraca tylko `{findings}`; kod wstrzykuje exact
quality/narrative fingerprints i wyprowadza wszystkie osiem dimension statuses. Gateway
rozróżnia walidację raw provider transportu w adapterze od ponownej walidacji już lokalnie
związanego outputu, więc żaden z dwóch kształtów nie może ominąć właściwego schematu.

## Moduły

- `srv/ai/contracts.ts` — vendor-neutral request, profile, wynik i fingerprint;
- `srv/ai/config.ts` — czysty loader trzech profili i ustawień runtime;
- `srv/ai/ai-gateway.ts` — task routing, UUID runu, fail-closed lifecycle i walidacja
  metadanych;
- `srv/ai/adapters/` — izolowane adaptery oficjalnych SDK, bez stałego modelu;
- `srv/ai/telemetry.ts` — asynchroniczny audit oraz niezależny, privacy-safe operational
  signal dla prób przed durable `STARTED`;
- `srv/ai/persistence/` — store CAP i persistent recorder;
- `srv/ai/live-smoke.ts` — osobna ścieżka operator-only;
- `srv/narratives/` — grounded context, model-safe/quality contexts, kontrakty
  generation-only view, `GENERATE`/`JUDGE`, deterministic finalization, precheck, review persistence, krótki odczyt i atomowy zapis
  zaakceptowanych narracji;
- `srv/evals/` — frozen dataset loader, offline harness, metryki, privacy-safe raporty,
  baseline binding, price snapshot i fail-closed live guard;
- `scripts/ai-*.ts` — lokalne helpery operatora.

Typy OpenAI i Anthropic pozostają wewnątrz adapterów. Nie ma tools, streamingu, web search,
MCP ani multimodalności.

## Task-aware profile

Każdy profil ma pełny kontrakt:

```ts
interface AiExecutionProfile {
  taskType: AiTaskType;
  provider: AiProvider;
  model: string;
  effort: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxOutputTokens: number;
}
```

| Zadanie    | Provider  | Model             | Effort | Max output tokens |
| ---------- | --------- | ----------------- | ------ | ----------------: |
| `DECIDE`   | OpenAI    | `gpt-5.6-luna`    | `none` |               512 |
| `GENERATE` | Anthropic | `claude-sonnet-5` | `low`  |              1600 |
| `JUDGE`    | OpenAI    | `gpt-5.6-luna`    | `low`  |              2048 |

OpenAI akceptuje wszystkie sześć wartości effort. Anthropic odrzuca `none`. Niepoprawny
profil kończy się `INVALID_AI_CONFIGURATION` przed utworzeniem klienta lub requestem
sieciowym.

`StructuredAiRequest` nie ma provider/model/effort override. Zawiera task type, wersje,
nazwę schematu, instrukcje, ugruntowane wejście JSON, lokalny schemat Zod oraz opcjonalny
`maxOutputTokens`. Limit requestu może tylko obniżyć limit profilu. Gateway nadpisuje
ewentualny wewnętrzny `aiRunId` własnym UUID.

## Konfiguracja

`loadAiConfig(env)` jest czystą funkcją i nigdy samodzielnie nie czyta `process.env`.
Credentiale są opcjonalne do chwili faktycznego wywołania wybranego adaptera.

| Zmienna                         | Default           | Walidacja                        |
| ------------------------------- | ----------------- | -------------------------------- |
| `AI_ENABLED`                    | `false`           | dokładnie `true` lub `false`     |
| `AI_LIVE_SMOKE_ENABLED`         | `false`           | dokładnie `true` lub `false`     |
| `AI_DECIDE_PROVIDER`            | `openai`          | `openai` albo `anthropic`        |
| `AI_DECIDE_MODEL`               | `gpt-5.6-luna`    | niepusty tekst                   |
| `AI_DECIDE_EFFORT`              | `none`            | effort zgodny z providerem       |
| `AI_DECIDE_MAX_OUTPUT_TOKENS`   | `512`             | integer 1–8192                   |
| `AI_GENERATE_PROVIDER`          | `anthropic`       | `openai` albo `anthropic`        |
| `AI_GENERATE_MODEL`             | `claude-sonnet-5` | niepusty tekst                   |
| `AI_GENERATE_EFFORT`            | `low`             | effort zgodny z providerem       |
| `AI_GENERATE_MAX_OUTPUT_TOKENS` | `1600`            | integer 1–8192                   |
| `AI_JUDGE_PROVIDER`             | `openai`          | `openai` albo `anthropic`        |
| `AI_JUDGE_MODEL`                | `gpt-5.6-luna`    | niepusty tekst                   |
| `AI_JUDGE_EFFORT`               | `low`             | effort zgodny z providerem       |
| `AI_JUDGE_MAX_OUTPUT_TOKENS`    | `2048`            | integer 1–8192                   |
| `AI_TIMEOUT_MS`                 | `30000`           | integer 1000–120000              |
| `AI_MAX_RETRIES`                | `1`               | integer 0–2                      |
| `AI_RUN_RETENTION_DAYS`         | `30`              | integer 1–365                    |
| `OPENAI_API_KEY`                | brak              | wymagany tylko do OpenAI call    |
| `ANTHROPIC_API_KEY`             | brak              | wymagany tylko do Anthropic call |

Finalny live eval ma osobny fail-closed loader i nie jest włączany przez sam gateway:

| Zmienna                                     | Default | Walidacja i hard cap                     |
| ------------------------------------------- | ------- | ---------------------------------------- |
| `AI_LIVE_EVAL_ENABLED`                      | `false` | dokładnie `true` lub `false`             |
| `AI_LIVE_EVAL_MAX_LOGICAL_CALLS`            | `48`    | positive integer, maksymalnie 48         |
| `AI_LIVE_EVAL_MAX_PROVIDER_ATTEMPTS`        | `56`    | positive integer, maksymalnie 56         |
| `AI_LIVE_EVAL_MAX_ESTIMATED_COST_USD_CENTS` | `300`   | positive integer, maksymalnie 300 centów |

Opt-in live eval nie wystarcza samodzielnie: preflight wymaga także `AI_ENABLED=true`,
credentiali, wersjonowanej ceny każdego dokładnego configured modelu i planu mieszczącego
się we wszystkich limitach. Unknown price lub przekroczenie rezerwacji blokuje call przed
providerem. Runner ma dokładnie 46 logical calls i wymaga `AI_MAX_RETRIES=0`. Niezmieniona
polityka `zero-retry-with-terminal-failure-accounting-v2` nadal oznacza zero retry, a jawne
kontrakty `narrative-quality-live-execution-v3` i `post-response-failure-accounting-v3`
rozdzielają fatalne awarie od kompletnie rozliczonego post-response invalid `JUDGE`. Przy
evidence niepełnym runner zatrzymuje się bez częściowego raportu i bez wymyślania usage,
attempts lub kosztu. Checked-in katalog cen zawiera oficjalne
stawki API zweryfikowane 2026-08-21. Credential-free `npm run eval:live:preflight` używa
dokładnie tego samego frozen planu i integer-only cost estimatora, ale nie czyta opt-inów ani
credentiali i nie ma ścieżki do executora, adaptera, gatewaya lub audit store. Pokazuje, że
runtime Luna/low/2048 ma ceiling 1,171,326 USD micros (346,331 `GENERATE`, 824,995 `JUDGE`)
i 1,828,674 micros headroomu, a Terra/2048 kosztuje 8,595,433 micros i pozostaje wyłącznie
comparison scenario ponad capem. Po wersjonowanej zmianie transport schema i kontraktów
wykonania oba mają workload fingerprint
`9c0550fb56ef2c23ece3b0be6b4c2f1b0d767426ccbf25e3a5260cf7ffe0cca1`;
nie istnieje automatyczny fallback między nimi. Po przejściu wszystkich guardów produkcyjnych
każdy baseline dostaje odizolowany SQLite store pod
`.tools/narrative-live-eval/`; zawiera on wyłącznie allow-listed `AiRuns`, bez promptu,
kontekstu, narracji, raw payloadu lub sekretu.

`narrative-quality-model-profile-v2` nadal wiąże exact JUDGE profile
`OPENAI/gpt-5.6-luna/low/2048`; GENERATE pozostaje `ANTHROPIC/claude-sonnet-5/low/1600`.
Provider-visible GENERATE schema v2 ma tylko blocks, JUDGE schema v3 ma tylko findings,
report/manifest mają v3, live plan/execution mają v2/v3, a failure accounting v3, price
catalog v1 i model profile v2 pozostają bez zmian. Live `PREFLIGHT_PASSED` allowlistuje
workload fingerprint, datę weryfikacji cen, exact profile, wersje planu/execution/accounting/
token/cost/retry, calls/attempts/cost i limits. Safe failure allowlistuje dostępne safe IDs,
provider/configuredModel/responseModel/latency/status/reason/usage/attempts oraz
`providerCallAttempted` i zamknięty `validationFailureStage`, nigdy błędu, payloadu ani raw
contentu.

Do końca Fazy 3B dostępne są deprecated aliases:

- dla `DECIDE` używającego OpenAI: `OPENAI_DECIDE_MODEL`,
  `OPENAI_REASONING_EFFORT`;
- dla `GENERATE` używającego Anthropic: `ANTHROPIC_GENERATE_MODEL`,
  `ANTHROPIC_EFFORT`.

Nowa zmienna ma pierwszeństwo. Alias innego providera jest ignorowany. Stary globalny
`AI_MAX_OUTPUT_TOKENS` nie jest używany. `.env.example` dokumentuje wyłącznie nowe nazwy i
puste credentiale. Aliasy zostaną usunięte po Fazie 3B.

Jawne `AI_<TASK>_PROVIDER`, które różni się od defaultu zadania, wymaga jawnego i niepustego
`AI_<TASK>_MODEL`. Brak modelu kończy się `INVALID_AI_CONFIGURATION` z
`details.field = AI_<TASK>_MODEL`. Loader nie dobiera modelu nowego providera i nie używa
legacy aliasu poprzedniego providera do spełnienia tego wymagania.

## Adapter per call

```ts
interface StructuredAiAdapter {
  readonly provider: AiProvider;
  call<T>(request: StructuredAiRequest<T>, profile: AiExecutionProfile): Promise<AiCallResult<T>>;
}
```

Adapter nie ma właściwości modelu. Sprawdza provider i task profilu, bierze model, effort i
limit z profilu, a timeout/retry/credential z głównej konfiguracji. OpenAI korzysta z
Responses API przez `responses.create(...).withResponse()`, structured outputs, `store: false`,
pustych tools i jawnego `reasoning.effort`. Anthropic korzysta z Messages API,
`output_config.format`, jawnego effort, wyłączonego thinking i pustych tools. Provider-visible
schema jest oddzielona od pełnego lokalnego kontraktu. Gateway dodatkowo uruchamia kontrolowany
lokalny validator po sprawdzeniu metadanych i przed durable `SUCCEEDED`, więc custom/test
adapter nie może ominąć kontraktu typem TypeScript.

Klient OpenAI najpierw zachowuje z terminalnej odpowiedzi wyłącznie zamknięte metadata: status,
`incomplete_details.reason`, bezpieczne request/response IDs, response model, usage, attempts
i kontrolowany response error code. Dopiero dla `COMPLETED` bez odmowy odczytuje przejściowy
`output_text` w pamięci, wykonuje `JSON.parse`, statyczną walidację transportową oraz jawne
`CONTEXT_BINDING`, `DIMENSION_BINDING` i `FINDING_BINDING`. Adapter klasyfikuje:

- `COMPLETED` z poprawnym JSON-em i wszystkimi lokalnymi bindingami → sukces;
- `INCOMPLETE / MAX_OUTPUT_TOKENS` → non-retryable `INCOMPLETE_MODEL_OUTPUT`;
- `INCOMPLETE / CONTENT_FILTER` → `MODEL_REFUSAL` z kategorią `content_filter`;
- `COMPLETED` bez output textu → `EMPTY_MODEL_OUTPUT`;
- `FAILED`, `CANCELLED`, `QUEUED`, `IN_PROGRESS` albo status nieznany → fail-closed
  `PROVIDER_ERROR`.

Nie ma auto-resume, retry ani dodatkowego provider calla. Produkt zawsze kończy invalid output
fail-closed. Wyłącznie syntetyczny runner może kontynuować istniejący plan po kompletnie
rozliczonym invalid `JUDGE`, potwierdzonym dokładnym durable terminalnym `FAILED` audytem; taki
case jest `REJECT`, a report oblewa jawne validity gates. `AiFailureExecutionEvidence` ma
runtime-enforced allowlist i nie zawiera pola na prompt, input, output, raw JSON, provider body,
raw message, cause, stack lub dowolne niekontrolowane `details`.

`store: false` ogranicza utrwalenie obiektu odpowiedzi przez OpenAI, ale samo nie gwarantuje
Zero Data Retention ani braku logów abuse monitoring. Ustawienia organizacji, ZDR i
dozwolony zakres danych muszą zostać zatwierdzone przed ustawieniem `AI_ENABLED=true` dla
produktowej akcji 3B2.

## Configured model i response model

`AiCallResult` zawiera osobno:

- `configuredModel` z profilu;
- `responseModel` z odpowiedzi providera.

Oba są niepuste. Provider może zwrócić dokładniejszy snapshot i sama różnica stringów nie
jest błędem. Bezpieczny wynik smoke również pokazuje oba pola.

Gateway odrzuca wynik jako `PROVIDER_ERROR`, jeśli nie zgadzają się:

- provider i configured model;
- task type;
- prompt version i schema version;
- fingerprint wejścia;
- UUID `aiRunId`;
- obecność niepustego response model.

Niezgodny wynik nie trafia do wywołującego.

## Recorder fail-closed

`AiRunRecorder.record(event)` zwraca `Promise<void>`. Konstruktor `AiGateway` wymaga jawnego
recordera. `NoopAiRunRecorder` jest asynchroniczny i zawsze kończy się sukcesem, ale może być
użyty tylko przez świadomą kompozycję testową/operator-only. Produkcyjny composition root
`createPersistentAiGateway(config, dependencies?)` zawsze składa `PersistentAiRunRecorder`
i `CapAiRunStore`, przekazuje `config.runRetentionDays` oraz domyślnie tworzy oba adaptery
SDK. Factory nie czyta `.env`, nie zapisuje do bazy i nie wykonuje requestu przy tworzeniu.

Lifecycle jednego UUID:

1. Gateway tworzy fingerprint, `aiRunId` i event `STARTED`.
2. Dopiero po trwałym `STARTED` wywołuje adapter.
3. Po poprawnym wyniku zapisuje `SUCCEEDED`, a dopiero potem zwraca output.
4. Po znormalizowanym błędzie zapisuje `FAILED` wraz z dostępnym closed execution evidence,
   a dopiero potem zwraca błąd. Opakowanie durable `aiRunId` zachowuje evidence.

Polityka jest zawsze fail-closed:

- błąd `STARTED` → brak call adaptera i `AI_AUDIT_FAILED`;
- błąd `SUCCEEDED` → output nie jest zwracany i `AI_AUDIT_FAILED`;
- błąd `FAILED` → `AI_AUDIT_FAILED`, opcjonalnie tylko pierwotny `errorCode` w details;
- poprawny `FAILED` → oryginalny, znormalizowany `AiError`.

Nie ma opcji fail-open.

Próba, która nie osiągnęła durable `STARTED`, nie ma prawdziwego `AiRunId` i nie tworzy
`NarrativeReviewRun`. Gateway nie fabrykuje UUID, nie wywołuje providera i nie zapisuje
candidate ani produktu. Zamiast zapisu do potencjalnie niedostępnej bazy wstrzykiwalny
`AiOperationalSignalSink` otrzymuje dokładnie jedną próbę emisji
`AI_PRE_START_FAILURE/BEFORE_DURABLE_STARTED` dla `GENERATE` lub `JUDGE`, z zamkniętym
failure code, allowlistowanym lineage/version/fingerprint i
`providerCallAttempted=false`. Kontrakt sygnału nie ma pól na `aiRunId`, prompt, input,
candidate, output, raw error/cause/stack, PII ani sekret. Wyjątek sinka nie zastępuje
pierwotnego fail-closed błędu.

## Wewnętrzne AiRuns

`AiRuns.ID` jest UUID gatewaya. Opcjonalne `planningRun` wiąże wykonanie narracji z planem w
czasie walidacji przed product write i nadal pozwala zachować runy smoke/eval bez planu.
Encja ma status/provider/task, oba modele, wersje, fingerprint, timestamps, `expiresAt`,
skonfigurowany effort, skonfigurowany i efektywny limit output tokens, token usage, latency,
attempts, provider request/response ID, allowlistowany response status/incomplete reason,
refusal oraz kontrolowany error code/retryability. Nowe runy
wypełniają metadata profilu przed `STARTED`; addytywne pola legacy pozostają nullable bez
defaultu. Jest to efemeryczny audyt wykonania, a nie dane produktu.

Encja celowo nie ma pól na prompt, instrukcje, wejście, output, raw response, raw error,
nagłówki ani credentiale. Nie jest projektowana w publicznym `TripPlannerService`; endpoint
`/trip-planner/AiRuns` nie istnieje.

`STARTED` wykonuje INSERT. `SUCCEEDED` i `FAILED` aktualizują dokładnie jeden rekord o tym
samym ID i statusie `STARTED`. Inna liczba rekordów kończy się `AI_AUDIT_FAILED`, więc
rekordu terminalnego nie można zakończyć ponownie. Każda operacja ma krótką, niezależną
transakcję CAP; request do providera nie trzyma transakcji bazy.

Na SQLite persistent gateway nie może działać po rozpoczęciu transakcji DB requestu. Próba
stworzyłaby circular wait na jedynym połączeniu puli, dlatego `CapAiRunStore` wykrywa taki
stan i kończy się fail-closed przed adapterem. Właściwa granica use case to: zakończona
krótka transakcja odczytu → `STARTED` → adapter → terminalny audit → osobna krótka
transakcja zapisu produktu. Realny test-only handler CAP potwierdza widoczność committed
`STARTED` w adapterze i zachowanie `SUCCEEDED` po rollbacku późniejszego product write.

`expiresAt` używa `AI_RUN_RETENTION_DAYS` (default 30). `deleteExpired(now)` usuwa wyłącznie
`expiresAt < now`. Kontrakt cleanup jest zaimplementowany i testowany, ale 3B1 nie dodaje
schedulera. Deployment lub kolejna faza operacyjna musi podłączyć jego wywołanie.

Narracje mają niezależny lifecycle produktu. Przed publikacją writer wymaga istniejących,
terminalnych `SUCCEEDED` z dokładnym `planningRun`, taskami `GENERATE` i `JUDGE`, wersjami
prompt/schema oraz exact input fingerprints. Następnie `NarrativeRuns` zapisuje UUID-y jako
niezmienne scalar IDs, bez association/foreign key do `AiRuns`; review, bloki i fact
references dziedziczą zwalidowane linkage. Dzięki temu cleanup audytu nie jest blokowany
przez produkt. Realny test CAP/SQLite wygasza oba audyty udanej narracji, wykonuje
`deleteExpired(now)`, potwierdza usunięcie `AiRuns` oraz dalszą czytelność i spójność review
i rekordów narracji.

## Offline testy, contract replay i ręczny smoke

Standardowe testy używają transportów HTTP in-memory i SQLite in-memory. Obejmują pełną
kompozycję gateway + mock adapter + persistent recorder + real store, a także test-only
request handler z twardym timeoutem pięciu sekund i kontrolą rollback independence. Nie wymagają
credentiali i nie wykonują sieci. Ręczne komendy pozostają dostępne, ale nie należą do CI,
`verify` ani `verify:full`:

```sh
npm run ai:credentials:check
npm run ai:smoke:openai
npm run ai:smoke:anthropic
npm run ai:smoke
```

Smoke wymaga `AI_LIVE_SMOKE_ENABLED=true`. Dla wskazanego providera wybiera pierwszy profil
w kolejności `DECIDE`, `GENERATE`, `JUDGE`, kopiuje model/effort i ogranicza output do 128.
Brak profilu providera kończy się `INVALID_AI_CONFIGURATION`; nie ma ukrytego model fallback.
Credential checker pokazuje wyłącznie presence flags, trzy profile, stan opt-in i retencję —
bez wartości, fragmentów lub długości kluczy.

`npm run eval:schema:check` jest częścią standardowej weryfikacji i porównuje canonical
runtime Zod z frozen JSON Schema. Po nim `npm run eval:offline` ładuje dokładnie 32 synthetic
semantic cases i cztery synthetic end-to-end contexts, waliduje frozen fingerprint, exact
distribution i kontrakty, a następnie wykonuje deterministic contract replay. Replay kopiuje
frozen expected labels do actual, dlatego raportuje `evidenceKind=CONTRACT_REPLAY` i
`modelQualityMeasured=false`: sprawdza loader, resolvery, metryki, gates i report path, lecz
nie jakość modelu. Metryki, progi i privacy-safe raporty nie zawierają promptów, kontekstów,
kandydatów ani raw provider payloads.

Live E2E ma dodatkowo zamknięty katalog executable `requiredProperties`. Każdy evaluator
działa na exact candidate/context/model view/constraints i nie korzysta z decyzji,
dimensions, findings ani reason codes `JUDGE`; naruszenie przegrywa nawet przy ośmiu `PASS`.
Raportowane `publicationBundleLinkageValidInMemory` jest tylko dowodem konstrukcji exact
bundle w pamięci. Osobny test CAP/SQLite używa produkcyjnego recordera/store/writera i po
realnym zapisie odczytuje exact lineage/fingerprint/bloki/references, sprawdza atomowość oraz
zachowanie review i produktu po cleanup obu `AiRuns`.

Finalny live baseline jest oddzielony od smoke i CI. Pierwszy osobno autoryzowany run z
2026-08-23 zatrzymał się na 18/46 (`R06`, `JUDGE`, `EMPTY_MODEL_OUTPUT`); 17 prób ma subtotal
32,386 USD micros, a próba 18 nie ma pełnego settlement. Drugi osobno autoryzowany run z
source `a4785502c6fe01e978dea1a85aa8d90ff66b90a6` zatrzymał się na 23/46 (`R12`, `JUDGE`,
`INCOMPLETE_MODEL_OUTPUT`, `INCOMPLETE/MAX_OUTPUT_TOKENS`) z kompletnym accountingiem 23 prób
i 45,732 USD micros. Nie powstał report ani accepted manifest, nie osiągnięto `GENERATE` i nie
wykonano rerunu. Ten offline fix wykonuje zero provider calls, kosztuje USD 0, nie autoryzuje
kolejnego baseline i utrzymuje Fazę 3B3 w `REVIEW`.

Trzeci osobno autoryzowany run z source
`abf0f4b258c5950381e597b0192580527d71953f` i workload fingerprintem
`280e6dba83aebdca5b32776956de7af95b7e4b3a69b1a37058cd3aa980f9bdf8` zatrzymał się
na `P01 / JUDGE / 1/46` z `INVALID_STRUCTURED_OUTPUT`. Safe evidence nie rozstrzygało, czy
provider call nastąpił, więc `attemptAccountingComplete=false`; zero znanych prób i zero
znanych USD micros jest wyłącznie settled subtotalem. Istnieje jeden `FAILED` `AiRun`, zero
review/narrative/`GENERATE`; nie wykonano retry, rerunu, smoke, diagnostycznego calla, resume,
continuation ani fallbacku. Privacy-safe SQLite SHA-256 to
`5039F1DAF0F434BC0BB231B7B8D9EC9F90AE1CA8A10CF980858A064CBA2BA37B`; raw danych nie
odczytywano. Ten corrective Draft PR jest również offline-only, nie autoryzuje następnego
baseline i utrzymuje Fazę 3B3 w `REVIEW`.

## Produktowy use case 3B3

`RankedOptions.generateNarrative()` buduje `grounded-option-context-v1` wyłącznie z udanego
`PlanningRun`, wybranej opcji, kategorii budżetu i istniejących source snapshots. Każdy fakt,
również `UNKNOWN` i `MISSING`, ma `factId` związany z dokładnym fingerprintem kontekstu.
Transport i nocleg otrzymują rozwiązywalne source snapshot IDs z persisted source contexts;
brak lub wieloznaczność mapowania kończy się fail-closed. Selection, score i agregat budżetu
są jawnie oznaczone jako wersjonowane `INTERNAL_DETERMINISTIC` derivations.

Minor units pozostają źródłem prawdy. Wspólny `currency-fraction-digits-v1` dopuszcza
obecnie PLN/EUR z dwiema cyframi i odrzuca JPY/KWD/nieznane kody na wejściu oraz podczas
budowy grounded context. Dokładna wersja jest utrwalana na `PlanningRuns`; reader i formatter
używają tej wartości i odrzucają brakujące/nieobsługiwane wersje zamiast podstawiać runtime
default. Każdy `BudgetItem` zachowuje osobne części confirmed/estimated, więc mieszane
additional fees pozostają odtwarzalne po agregacji. Kod sprawdza lineage wersji, wszystkie
kategorie, klasyfikacje, walutę, sumy i status kompletności, a
`grounded-money-display-v1` przygotowuje display dla limitu, sumy, confirmed, estimated,
per-person i remaining. Prompt zabrania modelowi dzielenia minor units, ustalania precision
i formatowania pieniędzy.
Prompt `grounded-option-narrative-prompt-v3` i provider schema
`grounded-option-narrative-schema-v2` wymagają niepustych referencji w każdym bloku i
rezerwują maksymalnie sześć provider blocks.

Nieznana, pusta, nieaktualna albo pochodząca z innego kontekstu referencja odrzuca cały
output. `GENERATE` otrzymuje `narrative-generation-view-v1`, nie pełny model view: pozostają
wyłącznie narratable fakty `KNOWN`, exact fact IDs i safe rank/role. Provenance,
`UNKNOWN`/`MISSING`, raw source URL/external ID, provider/source identity, source keys,
contexts, HTML i kontrolne/provider-shaped wartości są wykluczone.

Provider zwraca wyłącznie `{blocks}` i nie może ustawiać fingerprintu ani mandatory prose.
Lokalny finalizer wstrzykuje exact context fingerprint, następnie dokłada stable source
freshness/demo disclosure i jeden zbiorczy `UNKNOWN`/`MISSING` limitation block, jeśli są
wymagane. Exact code-owned references, kolejność, unikalność i finalny limit ośmiu bloków są
walidowane przed precheckiem, JUDGE i persistence. Provider prose nie jest przepisywane.

Po lokalnej finalizacji deterministyczny precheck weryfikuje exact provider-prefix/tail i
blokuje syntaktyczne/formatowe zagrożenia. Semantyczna niezgodność kwoty i nowe obliczenie
celowo trafiają do `JUDGE`. Frozen semantic dataset nadal zawiera przypadki uzupełnienia
`UNKNOWN` jako pomiar JUDGE, natomiast produktowy GENERATE nie otrzymuje tych wartości i ich
mandatory limitation jest code-owned.

`narrative-quality-context-v2` wiąże exact candidate, fingerprints, potwierdzone constraints
i wszystkie wymagane wersje. Wejście `JUDGE` zawiera dodatkowo pełny, checked-in-golden
compatible rubric contract, exact `rubricVersion`, canonical `rubricFingerprint`,
`qualityContextFingerprint` i `narrativeFingerprint`. Provider output ma tylko kontrolowane
findings. Kod wstrzykuje oba fingerprinty i wyprowadza osiem statuses; code-owned policy
publikuje wyłącznie zero findings, czyli osiem wyprowadzonych `PASS`.
Nowe review i narracje przechowują exact rubric fingerprint, a addytywne legacy rows
pozostają `null`. Reject zapisuje tylko safe review metadata w osobnej krótkiej transakcji i
zero tekstu produktu. Publish wymaga dokładnych terminalnych audytów obu tasków, a następnie
atomowo zapisuje review, `NarrativeRuns`, `OptionNarratives` i znormalizowane
`NarrativeFactReferences`.

Trwałe linkage używa historycznych scalar IDs, więc 30-dniowy domyślny cleanup audytu nie
narusza produktu ani durable review. Szczegółową decyzję grounded 3B2 opisuje ADR 0007,
quality gate — ADR 0008, rozdzielenie transportu i lokalnego bindingu — ADR 0009, a
code-owned finalization i findings-only JUDGE — ADR 0010.

## Znane ograniczenia i następne fazy

- produkt wykonuje AI wyłącznie po jawnej akcji na pojedynczej `RankedOption` i opt-in;
- cleanup nie ma schedulera;
- nie ma fallbacku providera/modelu;
- adaptery obsługują wyłącznie tekstowy structured output;
- precheck pozostaje wąski i nie zastępuje semantycznej oceny `JUDGE`; granica money-stage
  opisana wyżej wymaga potwierdzenia podczas review;
- produkt nie jest jeszcze włączony publicznie; trzy osobno autoryzowane live baseline
  zatrzymały się bez reportu, accepted manifestu lub rerunu, więc Faza 3B3 pozostaje
  `REVIEW`.
