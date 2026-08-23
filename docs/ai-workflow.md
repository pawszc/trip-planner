# Przepływ AI

## Stan Fazy 3B3 (`REVIEW — LIVE BASELINE STOPPED SAFELY / FAILURE-EVIDENCE FIX IN REVIEW`)

Faza 3B3 rozszerza pierwszy jawny use case produktu, bound action
`RankedOptions.generateNarrative()`, o fail-closed bramkę jakości. Akcja opisuje pojedynczą
opcję już wybraną przez kod i nie jest automatycznie wywoływana przez `startPlanning` ani
UI. `AI_ENABLED=false` pozostaje defaultem, więc bez jawnego opt-in nie powstaje audit ani
request do providera.

Każdy normalny request wskazuje `DECIDE`, `GENERATE` lub `JUDGE`. Gateway wybiera wyłącznie
skonfigurowany profil zadania; request nie może zmienić providera, modelu ani effort i może
tylko obniżyć limit output tokens. Operator smoke jest oddzielną ścieżką, nie provider
override w requestcie produktu.

## Lifecycle pojedynczego wykonania

1. Gateway sprawdza opt-in `AI_ENABLED` przed fingerprintem i jakimkolwiek audytem.
2. Wybiera pełny profil zadania i adapter tego providera.
3. Tworzy SHA-256 fingerprint dokładnego wejścia requestu oraz UUID `aiRunId`.
4. Asynchroniczny recorder utrwala `STARTED` w krótkiej transakcji CAP.
5. Dopiero po sukcesie `STARTED` adapter wykonuje request bez otwartej transakcji bazy.
6. Adapter lokalnie waliduje structured output i zwraca oba identyfikatory modelu.
7. Gateway ponownie waliduje output oraz provider, configured model, task, wersje,
   fingerprint, UUID i response model.
8. Recorder aktualizuje ten sam rekord do `SUCCEEDED`; dopiero wtedy output może wrócić.
9. Po błędzie adaptera recorder aktualizuje ten sam rekord do `FAILED`; jeśli terminalna
   odpowiedź dostarczyła bezpieczne metadata, zapisuje response model/status/reason/IDs,
   usage, attempts i latency. Dopiero wtedy wraca znormalizowany błąd z zachowanym evidence.

Na SQLite ten lifecycle nie może zaczynać się wewnątrz rozpoczętej transakcji DB requestu,
bo niezależny audit czekałby na jedyne połączenie trzymane przez outer request. Store
odrzuca taki układ fail-closed. Produktowy handler 3B3 musi użyć faz: `krótki read i commit
→ GENERATE audit/provider/audit → lokalny precheck → JUDGE audit/provider/audit → osobny
krótki product/review write`.

Recorder jest fail-closed. Błąd dowolnego wymaganego zapisu kończy się
`AI_AUDIT_FAILED`. Brak trwałego `STARTED` bezwzględnie blokuje request do providera, a brak
trwałego `SUCCEEDED` blokuje użycie poprawnego outputu.

Jeżeli `GENERATE` lub `JUDGE` nie osiągnie durable `STARTED` — w tym przy disabled/config,
nieprawidłowym ID/fingerprint/time albo błędzie insertu — nie istnieje prawdziwy `AiRunId`,
więc nie powstaje `NarrativeReviewRun` ani fikcyjny UUID. Gateway emituje dokładnie jedną
próbę allowlistowanego `AI_PRE_START_FAILURE` do niezależnego operational sinka, zawsze z
`providerCallAttempted=false`. Sygnał nie zawiera promptu, inputu, candidate, outputu, raw
błędu/cause/stack, PII, sekretu ani `aiRunId`. Dla pre-`STARTED` `JUDGE` pozostaje wyłącznie
prawdziwy, wcześniejszy audit `GENERATE`; produkt nadal nie jest zapisywany.

`AiRuns` przechowuje tylko metadane wykonania i retencję. Prompt, instrukcje, wejście,
output i surowe błędy nigdy nie są utrwalane. Encja jest wewnętrzna i nie ma endpointu
OData. Jest efemeryczna: default retencji wynosi 30 dni, konfiguracja zachowuje zakres
1–365 dni, a cleanup ma testowalny kontrakt `deleteExpired(now)`, ale nie ma jeszcze
schedulera. Narracje są danymi produktu i nie mają mandatory association do `AiRuns`.

Terminalny kontrakt OpenAI rozróżnia `INCOMPLETE / MAX_OUTPUT_TOKENS` jako non-retryable
`INCOMPLETE_MODEL_OUTPUT`, `INCOMPLETE / CONTENT_FILTER` jako `MODEL_REFUSAL`, completed bez
parsed outputu jako `EMPTY_MODEL_OUTPUT`, a failed/cancelled/queued/in-progress/unknown jako
fail-closed `PROVIDER_ERROR`. `AiFailureExecutionEvidence` jest zamknięte i nie ma miejsca
na prompt, input, output, provider body, raw message, cause lub stack. Nie ma continuation,
auto-resume ani retry.

## Quality-gated narrative w Fazie 3B3

1. Osobna krótka transakcja odczytu pobiera udany `PlanningRun`, finansowe pola powiązanego
   `TripRequest`, jedną `RankedOption`, jej `BudgetItems` oraz `SourceSnapshots`, a następnie
   kończy się przed AI.
2. Kod buduje `grounded-option-context-v1`, jawnie materializuje `UNKNOWN`/`MISSING`,
   sortuje fakty i tworzy fingerprint canonical JSON. Transport i nocleg dostają dokładne
   source snapshot IDs z persisted source contexts; brak lub wieloznaczność kończy się
   fail-closed. Lineage fixture/scoringu oraz zgodność kategorii z agregatem budżetu są
   walidowane przed utworzeniem faktów. Reader używa utrwalonej wersji kontraktu walut i
   wymaga części confirmed/estimated każdej kategorii; nie odtwarza ich ani wersji z
   bieżących stałych. Code-derived score, selection i agregat budżetu mają jawne wersje
   derivation.
3. Każdy fakt otrzymuje deterministyczny `factId` związany z wersją i dokładnym
   fingerprintem kontekstu. Kod tworzy też display pieniędzy przez zamknięty dwucyfrowy
   kontrakt PLN/EUR; model nie dzieli ani nie formatuje kwot.
4. Kod tworzy `narrative-model-view-v1`. Zachowuje fakty potrzebne modelowi, provenance
   status, display, fact IDs i lineage, ale usuwa raw URL-e, external IDs, HTML, znaki
   kontrolne oraz zbędne provider-shaped wartości. Klucze provenance zmienia na
   deterministyczne, wersjonowane opaque keys wyprowadzane tylko z bezpiecznego `factId`,
   bez użycia `sourceKey`, provider identity, URL, external ID lub source contexts. Model
   view wiąże fingerprint pełnego kontekstu z własnym canonical fingerprintem.
5. Gateway wybiera wyłącznie profil `GENERATE`, zapisuje durable `STARTED`, wykonuje call
   bez transakcji produktu i zapisuje terminalny audit. Strict Zod wymaga dokładnego
   grounded fingerprintu i niepustych `factReferences`; lokalna walidacja odrzuca cały
   niezgodny output.
6. Deterministyczny precheck blokuje formatowe i syntaktyczne przypadki bezpieczeństwa,
   zanim powstanie płatny `JUDGE`: URL/Markdown (w tym reference-style definitions,
   full/collapsed/image references i autolinks), HTML/script/event handlers, control/bidi,
   wykluczone wartości i mechanicznie wykrywalny niedozwolony reformat pieniędzy. Precheck
   reject wykonuje zero `JUDGE` calls i zapisuje wyłącznie safe review metadata.
7. Semantyczna niezgodność kwoty, nowe obliczenie i uzupełnienie `UNKNOWN` nie są
   rozstrzygane heurystyką prechecku. Frozen dataset przypisuje je do `JUDGE`, więc trafiają
   wraz z kandydatem, exact constraints, fingerprints i wersjami do
   `narrative-quality-context-v1`.
8. Gateway wykonuje dokładnie jeden profil `JUDGE` z własnym durable lifecycle. Strict
   wejście zawiera pełny golden-compatible rubric contract, exact rubric version,
   `rubricFingerprint`, `qualityContextFingerprint` i `narrativeFingerprint`. Validator
   wymaga wszystkich ośmiu wymiarów dokładnie raz, zamkniętych reason codes/severity,
   istniejących block/fact references i exact fingerprintów. Model nie definiuje własnej
   rubryki i nie zwraca wiążącego overall verdict ani persistowalnego rationale.
9. Kod wylicza decyzję: osiem `PASS` i zero findings daje `PUBLISH`; każdy `FAIL` albo
   finding daje `REJECT`. Semantic reject utrwala bezpieczne review metadata w osobnej
   krótkiej transakcji, bez tekstu kandydata i bez rekordów produktu narracji.
10. Dla `PUBLISH` writer wymaga exact terminalnych `SUCCEEDED` obu audytów, po czym jedna
    krótka transakcja atomowo zapisuje review, `NarrativeRuns`, `OptionNarratives` i
    `NarrativeFactReferences`. Historyczne scalar IDs nie tworzą mandatory associations do
    efemerycznych `AiRuns`.
11. Awaria dowolnej fazy nie zmienia opcji, rankingu, constraints ani budżetu. Rollback
    product write nie usuwa wcześniej zatwierdzonych audytów, a cleanup `AiRuns` nie usuwa
    durable review ani zaakceptowanej narracji.

## Docelowy przepływ produktu

1. Krótka transakcja odczytu kończy się i uwalnia połączenie przed AI.
2. Kod waliduje constraints i usuwa niewykonalne kandydatury.
3. Grounding wiąże fakty z `SourceSnapshot` i jawnie zachowuje braki.
4. `DECIDE` klasyfikuje wyłącznie dane o ustalonym schemacie.
5. `GENERATE` opisuje wybrane przez kod warianty i kompromisy bez liczenia kosztów.
6. `JUDGE` kontroluje zgodność, ryzyka i zakazane poluzowanie ograniczeń.
7. Output może zostać użyty tylko po lokalnej walidacji i terminalnym audycie.
8. Osobna krótka transakcja zapisuje wynik produktowy; jej rollback nie usuwa audytu.
9. Plan dzień po dniu powstaje dopiero po wyborze wariantu.

Faza 3B3 implementuje dla narracji kroki 1, 3, 5–8 tego przepływu oraz deterministic offline
contract replay. Replay kopiuje frozen expected labels do actual, więc weryfikuje loader,
resolvery, kontrakty, metryki, gates i report path, ale ma
`modelQualityMeasured=false`. Standardowy `verify` chroni też parity runtime Zod z frozen
JSON Schema. Live E2E ma osobne, deterministic `requiredProperties`, które nie korzystają z
werdyktu ani findings `JUDGE`; sama walidacja publication bundle pozostaje dowodem in-memory,
a realny zapis/linkage jest testowany na produkcyjnym CAP/SQLite. Faza nie wykonuje
`DECIDE`. Jedyny autoryzowany finalny synthetic live baseline został wykonany dokładnie raz
2026-08-23 i zatrzymał się fail-closed na 18/46 (`R06`, `JUDGE`, `EMPTY_MODEL_OUTPUT`).
Sekwencje 1–17 mają kompletny subtotal USD 0.032386; accounting próby 18 jest niepełny, więc
pełny koszt nie jest deklarowany. Nie powstał report ani accepted manifest, nie było rerunu i
AI pozostaje wyłączone. Ten failure-evidence hardening wykonuje zero provider calls i kosztuje
USD 0, dlatego faza pozostaje w `REVIEW`.
