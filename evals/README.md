# Evals

Ten katalog przechowuje frozen kontrakty narrative-quality Fazy 3B3. `datasets/`,
`schemas/` i `rubrics/` opisują odpowiednio syntetyczne przypadki, maszynowy kontrakt danych
i kryteria jakości. Implementacja loadera, metryk, offline harnessu, privacy-safe raportów,
baseline binding, price arithmetic i live guard znajduje się w `srv/evals/`.

`npm run eval:offline` jest deterministycznym contract replay, credential-free i należy do
standardowej weryfikacji. Frozen expected labels są w tym mechanizmie kopiowane do actual,
więc wynik ma `evidenceKind=CONTRACT_REPLAY` i `modelQualityMeasured=false`: potwierdza
integralność loadera, resolverów, kontraktów, metryk, gates i report pipeline, ale nie mierzy
jakości `GENERATE` ani `JUDGE`. Nie wykonuje sieci ani paid calls i nie zastępuje testów
twardych reguł, persistence, arytmetyki domenowej ani osobnego live baseline.

Standardowy `verify` wykonuje przed replayem `npm run eval:schema:check`. Komenda generuje
JSON Schema z runtime Zod i porównuje jego canonical form oraz fingerprint z frozen
`schemas/narrative-quality-v1.schema.json`; nie aktualizuje golden artifact automatycznie.

Live E2E wykonuje zamknięty, wersjonowany katalog deterministic `requiredProperties` na
exact candidate/context/model view/constraint snapshot. Te oracle nie korzystają z decyzji,
dimensions, findings ani reason codes `JUDGE`, dlatego all-`PASS` judge nie jest samodzielnym
dowodem przejścia. Raport zawiera tylko allowlistowane property IDs, wynik i kontrolowany
failure code. Pole `publicationBundleLinkageValidInMemory` dowodzi wyłącznie spójności bundle
w pamięci; realny zapis i odczyt jest osobno testowany na produkcyjnych writerach CAP/SQLite.

Finalny live baseline używa wyłącznie danych syntetycznych, jest poza CI i wymaga osobnej
zgody, `AI_LIVE_EVAL_ENABLED=true`, przejścia preflightu oraz limitów 48 logical calls, 56
provider attempts i USD 3.00. Plan v1 ma dokładnie 46 calls i wymaga
`AI_MAX_RETRIES=0`. `npm run eval:live:preflight` jest osobną, credential-free i
network-free kalkulacją tego samego planu oraz kosztu. Runtime scenario
`SCENARIO_RUNTIME_LUNA` używa `OPENAI / gpt-5.6-luna / low / 2048`, przechodzi cap z ceiling
1,185,201 USD micros (401,101 `GENERATE`, 784,100 `JUDGE`) i ma kodowy headroom 1,814,799
micros. `SCENARIO_COMPARISON_TERRA` używa tego samego workloadu i ceiling 2048, ale kosztuje
8,241,209 micros i pozostaje wyłącznie comparison scenario ponad capem, bez semantyki
fallbacku. Workload fingerprint obu exact workloadów to
`280e6dba83aebdca5b32776956de7af95b7e4b3a69b1a37058cd3aa980f9bdf8`.

Pierwszy osobno autoryzowany run z 2026-08-23 na source
`7af918ded8ee7b30d3fdabd92d705c2dd34e7c49` zatrzymał się fail-closed na 18/46 (`R06`,
`JUDGE`, `EMPTY_MODEL_OUTPUT`). Sekwencje 1–17 mają 17 prób i subtotal 32,386 USD micros;
próba 18 nie ma kompletnego usage/attempt settlement, więc pełny koszt jest nieznany i
`attemptAccountingComplete=false`.

Drugi osobno autoryzowany run na source
`a4785502c6fe01e978dea1a85aa8d90ff66b90a6` przeszedł preflight 46 calls/46 attempts z
ceiling 1,056,177 micros dla wcześniejszego Luna/768 i zatrzymał się na 23/46: `R12`,
`JUDGE`, `INCOMPLETE_MODEL_OUTPUT`, provider status `INCOMPLETE`, reason
`MAX_OUTPUT_TOKENS`. Accounting jest kompletny: 23 próby i 45,732 USD micros. Dozwolony
offline forensic check potwierdził 22 `SUCCEEDED` i jeden `FAILED`, exact
configured/response model `gpt-5.6-luna`, a failed attempt użył 5,810 input, 768 output, 350
reasoning tokens i 14,158 ms. W żadnym runie nie osiągnięto `GENERATE`, nie powstał raport
jakości ani accepted manifest i nie było rerunu.

Retry policy `zero-retry-with-terminal-failure-accounting-v2` zachowuje zero retry. Runner
rozlicza failed attempt tylko z zamkniętego `AiFailureExecutionEvidence`; privacy-safe
failure przenosi z niego dostępne provider/configuredModel/responseModel/latency oraz
dotychczasowe status/reason/usage/attempts bez provider IDs lub raw contentu. Live
`PREFLIGHT_PASSED` emituje workload fingerprint, verified pricing, exact profile i wszystkie
wersje planu/cost/retry ceiling. Ten offline fix i wszystkie jego testy wykonują zero provider
calls, kosztują USD 0, nie autoryzują kolejnego baseline i utrzymują Fazę 3B3 w `REVIEW`.
