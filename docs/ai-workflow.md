# Przepływ AI

## Stan Fazy 3B3 (`REVIEW — CONTRACT-V2 HARDENED OFFLINE / NO NEW LIVE BASELINE`)

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
5. Dopiero po sukcesie `STARTED` adapter konstruuje provider schema i wykonuje request bez
   otwartej transakcji bazy.
6. Adapter zachowuje allowlistowane response metadata przed `JSON.parse`, transport schema i
   jawnymi context/finalization/dimension/finding bindingami; raw output istnieje tylko
   przejściowo w pamięci. Raw provider transport, exact binding i deterministic narrative policy
   mają osobne zamknięte failure stages.
7. Gateway ponownie uruchamia kontrolowany lokalny validator oraz sprawdza provider, configured
   model, task, wersje,
   fingerprint, UUID i response model.
8. Recorder aktualizuje ten sam rekord do `SUCCEEDED`; dopiero wtedy output może wrócić.
9. Po błędzie adaptera recorder aktualizuje ten sam rekord do `FAILED`; jeśli terminalna
   odpowiedź dostarczyła bezpieczne metadata, zapisuje response model/status/reason/IDs,
   usage, attempts, latency, `providerCallAttempted` i zamknięty `validationFailureStage`.
   Dopiero wtedy wraca znormalizowany błąd z zachowanym evidence i durable linkage.

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
output textu jako `EMPTY_MODEL_OUTPUT`, a failed/cancelled/queued/in-progress/unknown jako
fail-closed `PROVIDER_ERROR`. Dla `COMPLETED` klasyfikuje malformed JSON oraz transport,
context, narrative finalization, dimension i finding binding bez analizy tekstu błędu.
`AiFailureExecutionEvidence`
jest zamknięte i nie ma miejsca na prompt, input, output, provider body, raw message, cause lub
stack. Produkt nie ma continuation, auto-resume ani retry; syntetyczny runner może jedynie
przejść do następnej zaplanowanej operacji po kompletnie rozliczonym invalid `JUDGE` z exact
durable `FAILED` linkage, a report i wszystkie validity gates pozostają fail-closed.

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
4. Kod tworzy pełny lokalny `narrative-model-view-v1`, a z niego osobny
   `narrative-generation-view-v1`. Provider `GENERATE` widzi wyłącznie safe rank/role i fakty
   `KNOWN`, które wolno opisywać. Nie widzi provenance, `UNKNOWN`/`MISSING`, raw URL-i,
   provider/source identity, external IDs ani source keys. Projekcja jest kanoniczna,
   fingerprinted, size-bounded i walidowana względem exact grounded context. Zamknięty projector
   jawnie mapuje każdy wspierany fact key i value shape; dodatkowe pola i nieznane klucze failują.
   Nie ma globalnego porównywania source strings z niezależnym fact value, fact ID, fingerprintem
   ani object key.
5. Gateway wybiera wyłącznie profil `GENERATE`, zapisuje durable `STARTED`, wykonuje call
   bez transakcji produktu i zapisuje terminalny audit. Provider transport zawiera tylko
   `blocks` (maksymalnie sześć), bez fingerprintu i mandatory disclosures. Lokalny binder
   odrzuca restricted references/prose. Money, date/time i pozostałe tokeny liczbowe muszą
   pochodzić dokładnie z cytowanego faktu `KNOWN`; raw minor units nie są narratable values.
   Zamknięty katalog EN/PL rezerwuje dla kodu source freshness oraz twierdzenia uzupełniające
   non-`KNOWN` value/status. Reguła jest fact-reference- i assertion-aware: sam rzeczownik
   `transport`, `hotel` albo `accommodation` nie blokuje opisu osobnego faktu `KNOWN`. Binder
   wstrzykuje exact context fingerprint i dokłada w stałej kolejności
   najwyżej dwa code-owned bloki `RISK`: provenance/freshness, potem `UNKNOWN`/`MISSING`.
   Finalny kontrakt ma maksymalnie osiem bloków i jest walidowany jeszcze raz bez
   przepisywania provider prose.
6. Deterministyczny precheck weryfikuje również exact provider-prefix/deterministic-tail
   finalization i blokuje formatowe i syntaktyczne przypadki bezpieczeństwa,
   zanim powstanie płatny `JUDGE`: URL/Markdown (w tym reference-style definitions,
   full/collapsed/image references i autolinks), HTML/script/event handlers, control/bidi,
   wykluczone wartości, uncited/reformatted money/date/time/number claims i provider-owned
   disclosures. Production/E2E entry point wymaga exact `generationView`; brak tego dowodu
   jest fail-closed. Frozen authored JUDGE-stage cases używają jawnie nazwanej, eval-only
   ścieżki content-safety bez udawania finalizacji GENERATE. Precheck reject wykonuje zero
   `JUDGE` calls i zapisuje wyłącznie safe review metadata.
7. Provider nie może uzupełnić `UNKNOWN`/`MISSING`: tych faktów nie ma w generation view,
   claim o ich cenie/kwocie/statusie jest lokalnie zastrzeżony, a exact limitation block tworzy
   kod. Niezależny fakt `KNOWN`, na przykład direct train albo hotel identity/nights, pozostaje
   narratable przy nieznanym koszcie tej kategorii, jeżeli blok cytuje dokładny fakt i nie twierdzi
   niczego o brakującej cenie lub availability.
   Uncited liczba lub zmieniony display również kończy się przed `JUDGE`. Pełny zaakceptowany
   kandydat, constraints, fingerprints i wersje trafiają do `narrative-quality-context-v2`.
8. Gateway wykonuje dokładnie jeden profil `JUDGE` z własnym durable lifecycle. Strict
   wejście zawiera pełny golden-compatible rubric v2 i exact local binding. Provider zwraca
   tylko zamknięte findings: dimension, reason code, severity, istniejące block sequences i
   in-context fact IDs. Nie zwraca fingerprintów, tablicy statuses, verdictu ani rationale.
   Kod wstrzykuje exact quality/narrative fingerprints i wyprowadza osiem statuses z findings.
9. Kod wylicza decyzję: zero findings daje osiem `PASS` i `PUBLISH`; każdy finding daje
   `FAIL` w nazwanym wymiarze i `REJECT`. Semantic reject utrwala bezpieczne review metadata w osobnej
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
`DECIDE`. Pierwszy osobno autoryzowany one-shot baseline z 2026-08-23 zatrzymał się na 18/46
(`R06`, `JUDGE`, `EMPTY_MODEL_OUTPUT`): 17 prób ma subtotal 32,386 USD micros, a accounting
próby 18 jest niepełny. Drugi osobno autoryzowany one-shot baseline z source
`a4785502c6fe01e978dea1a85aa8d90ff66b90a6` zatrzymał się na 23/46 (`R12`, `JUDGE`,
`INCOMPLETE_MODEL_OUTPUT`, `INCOMPLETE/MAX_OUTPUT_TOKENS`); accounting jest kompletny dla 23
prób i 45,732 USD micros. Trzeci osobno autoryzowany one-shot baseline z source
`abf0f4b258c5950381e597b0192580527d71953f` zatrzymał się na `P01 / JUDGE / 1/46` z
`INVALID_STRUCTURED_OUTPUT`, jednym `FAILED` `AiRun` i niepełnym accountingiem; zero known
attempts/cost było tylko settled subtotalem. W żadnym runie nie powstał report ani accepted
manifest i nie było rerunu. Późniejszy contract-v2 hardening wprowadza dataset/fixture v2,
generation view v1, code-owned finalization, JUDGE findings-only schema v3, rubric v2,
quality-context v2, report/manifest v3 oraz live plan/execution v2/v3. Failure accounting v4
zawiera osobny `NARRATIVE_FINALIZATION`; profile, zero retry i hard caps pozostają bez zmian.
Ta zmiana
wykonuje zero provider calls za USD 0 i nie tworzy accepted manifestu. AI pozostaje wyłączone,
faza pozostaje w `REVIEW`, a kolejny baseline wymaga nowej zgody.
