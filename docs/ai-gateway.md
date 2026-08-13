# AI execution i grounded narratives po Fazie 3B2

## Cel i granice

Faza 3B1 dodała task-aware profile wykonania, walidację metadanych adaptera i trwały audyt
`AiRuns`. Faza 3B2 wykorzystuje ten fundament w jednej jawnej bound action
`RankedOptions.generateNarrative()`. `TripRequests.startPlanning()` i UI nadal nie wykonują
AI. Gateway jest domyślnie wyłączony, a standardowe testy są offline i nie potrzebują
credentiali.

Kod pozostaje jedynym źródłem prawdy dla hard constraints, kompletności danych, workflow,
rankingu i arytmetyki finansowej. Model nie może uzupełniać brakujących faktów ani liczyć
budżetu.

## Moduły

- `srv/ai/contracts.ts` — vendor-neutral request, profile, wynik i fingerprint;
- `srv/ai/config.ts` — czysty loader trzech profili i ustawień runtime;
- `srv/ai/ai-gateway.ts` — task routing, UUID runu, fail-closed lifecycle i walidacja
  metadanych;
- `srv/ai/adapters/` — izolowane adaptery oficjalnych SDK, bez stałego modelu;
- `srv/ai/telemetry.ts` — asynchroniczny kontrakt bez payloadów;
- `srv/ai/persistence/` — store CAP i persistent recorder;
- `srv/ai/live-smoke.ts` — osobna ścieżka operator-only;
- `srv/narratives/` — grounded context, prompt/schema, krótki odczyt i atomowy zapis
  zwalidowanych narracji;
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
| `JUDGE`    | OpenAI    | `gpt-5.6-terra`   | `low`  |               768 |

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
| `AI_JUDGE_MODEL`                | `gpt-5.6-terra`   | niepusty tekst                   |
| `AI_JUDGE_EFFORT`               | `low`             | effort zgodny z providerem       |
| `AI_JUDGE_MAX_OUTPUT_TOKENS`    | `768`             | integer 1–8192                   |
| `AI_TIMEOUT_MS`                 | `30000`           | integer 1000–120000              |
| `AI_MAX_RETRIES`                | `1`               | integer 0–2                      |
| `AI_RUN_RETENTION_DAYS`         | `30`              | integer 1–365                    |
| `OPENAI_API_KEY`                | brak              | wymagany tylko do OpenAI call    |
| `ANTHROPIC_API_KEY`             | brak              | wymagany tylko do Anthropic call |

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
Responses API, structured outputs, `store: false`, pustych tools i jawnego
`reasoning.effort`. Anthropic korzysta z Messages API, `output_config.format`, jawnego
effort, wyłączonego thinking i pustych tools. Oba wyniki przechodzą ponowną lokalną
walidację Zod. Gateway dodatkowo waliduje `result.output` tym samym schematem po sprawdzeniu
metadanych i przed durable `SUCCEEDED`, więc custom/test adapter nie może ominąć kontraktu
typem TypeScript.

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
4. Po znormalizowanym błędzie zapisuje `FAILED`, a dopiero potem zwraca błąd.

Polityka jest zawsze fail-closed:

- błąd `STARTED` → brak call adaptera i `AI_AUDIT_FAILED`;
- błąd `SUCCEEDED` → output nie jest zwracany i `AI_AUDIT_FAILED`;
- błąd `FAILED` → `AI_AUDIT_FAILED`, opcjonalnie tylko pierwotny `errorCode` w details;
- poprawny `FAILED` → oryginalny, znormalizowany `AiError`.

Nie ma opcji fail-open.

## Wewnętrzne AiRuns

`AiRuns.ID` jest UUID gatewaya. Opcjonalne `planningRun` wiąże produktowe wykonanie narracji
z planem i nadal pozwala zachować runy smoke/eval bez planu. Encja ma status/provider/task, oba modele,
wersje, fingerprint, timestamps, `expiresAt`, token usage, latency, attempts, provider
request ID, refusal oraz kontrolowany error code/retryability.

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

## Offline testy i ręczny smoke

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

## Produktowy use case 3B2

`RankedOptions.generateNarrative()` buduje `grounded-option-context-v1` wyłącznie z udanego
`PlanningRun`, wybranej opcji, kategorii budżetu i istniejących source snapshots. Każdy fakt,
również `UNKNOWN` i `MISSING`, ma `factId` związany z dokładnym fingerprintem kontekstu.
Prompt `grounded-option-narrative-prompt-v1` i strict schema
`grounded-option-narrative-schema-v1` wymagają niepustych referencji w każdym bloku.

Nieznana, pusta, nieaktualna albo pochodząca z innego kontekstu referencja odrzuca cały
output. Po ponownej lokalnej walidacji osobna transakcja zapisuje `NarrativeRuns`,
`OptionNarratives` i znormalizowane `NarrativeFactReferences` powiązane z dokładnym
`AiRun`. Szczegółową decyzję opisuje ADR 0007.

## Znane ograniczenia i następne fazy

- produkt wykonuje AI wyłącznie po jawnej akcji na pojedynczej `RankedOption` i opt-in;
- poprawne referencje nie są semantycznym dowodem groundedness bez przyszłego `JUDGE`;
- cleanup nie ma schedulera;
- nie ma fallbacku providera/modelu;
- adaptery obsługują wyłącznie tekstowy structured output;
- Faza 3B3 doda wykonywanie `JUDGE`, safety pipeline i evale.
