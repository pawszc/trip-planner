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
`schemas/narrative-quality-v2.schema.json`; nie aktualizuje golden artifact automatycznie.

Live E2E wykonuje zamknięty, wersjonowany katalog deterministic `requiredProperties` na
exact candidate/context/model view/constraint snapshot. Te oracle nie korzystają z decyzji,
dimensions, findings ani reason codes `JUDGE`, dlatego all-`PASS` judge nie jest samodzielnym
dowodem przejścia. Raport zawiera tylko allowlistowane property IDs, wynik i kontrolowany
failure code. Pole `publicationBundleLinkageValidInMemory` dowodzi wyłącznie spójności bundle
w pamięci; realny zapis i odczyt jest osobno testowany na produkcyjnych writerach CAP/SQLite.

Aktualny dataset/fixture v2 zachowuje tracked v1 artifacts. P03 ma jedną canonical wartość
4665 minut, wyliczaną wspólnym helperem produkcyjnym z exact synthetic timestamps. E2E
`GENERATE` używa `narrative-generation-view-v1` z samymi narratable `KNOWN` facts i provider
transportu `{blocks}` (maksymalnie 6). Kod wstrzykuje context fingerprint i dokłada exact
provenance oraz `UNKNOWN`/`MISSING` blocks do finalnego limitu 8. JUDGE schema v3 zwraca
wyłącznie closed findings; code-owned binder wyprowadza fingerprinty i wszystkie statuses.
Report v3 przechowuje tylko zamknięte, privacy-safe E2E arrays, a manifest v3 odbudowuje je
kanonicznie. W repozytorium nie ma accepted manifestu v3.

Finalny live baseline używa wyłącznie danych syntetycznych, jest poza CI i wymaga osobnej
zgody, `AI_LIVE_EVAL_ENABLED=true`, przejścia preflightu oraz limitów 48 logical calls, 56
provider attempts i USD 3.00. Plan v2 ma dokładnie 46 calls i wymaga
`AI_MAX_RETRIES=0`. `npm run eval:live:preflight` jest osobną, credential-free i
network-free kalkulacją tego samego planu oraz kosztu. Runtime scenario
`SCENARIO_RUNTIME_LUNA` używa `OPENAI / gpt-5.6-luna / low / 2048`, przechodzi cap z ceiling
1,171,326 USD micros (346,331 `GENERATE`, 824,995 `JUDGE`) i ma kodowy headroom 1,828,674
micros. `SCENARIO_COMPARISON_TERRA` używa tego samego workloadu i ceiling 2048, ale kosztuje
8,595,433 micros i pozostaje wyłącznie comparison scenario ponad capem, bez semantyki
fallbacku. Workload fingerprint obu exact workloadów to
`9c0550fb56ef2c23ece3b0be6b4c2f1b0d767426ccbf25e3a5260cf7ffe0cca1`.

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

Trzeci osobno autoryzowany run na source
`abf0f4b258c5950381e597b0192580527d71953f` użył poprzedniego workload fingerprintu
`280e6dba83aebdca5b32776956de7af95b7e4b3a69b1a37058cd3aa980f9bdf8`, Luna/low/2048,
46 calls/attempts maximum, zero retry i ceiling 1,185,201 micros. Zatrzymał się dokładnie na
`P01 / JUDGE / 1/46` z `INVALID_STRUCTURED_OUTPUT`; report nie powstał, accounting był
niepełny, a zero known attempts / zero known cost było wyłącznie settled subtotalem. Jeden
`FAILED` `AiRun`, zero review/narrative/`GENERATE`, SQLite audit SHA-256
`5039F1DAF0F434BC0BB231B7B8D9EC9F90AE1CA8A10CF980858A064CBA2BA37B`; bez odczytu raw
danych i bez rerunu, smoke, diagnostycznego requestu, retry, resume, continuation lub fallbacku.

Retry policy `zero-retry-with-terminal-failure-accounting-v2` zachowuje zero retry. JUDGE
schema v3 ma statyczny provider transport `{findings}` bez fingerprintów i tablicy statuses.
Exact fingerprints i osiem wymiarów są wstrzykiwane lub wyprowadzane lokalnie, a finding
cross-fields pozostają związane z exact context. Execution v3 i failure accounting v3
pozwalają kontynuować wyłącznie kompletnie rozliczony post-response invalid `JUDGE` z exact
durable `FAILED` linkage. Primary, repeat i E2E mają osobne validity gates.
`narrative-quality-eval-report-v3` dodaje do każdego wiersza E2E wyłącznie sortowane, unikalne,
zamknięte `actualFailedDimensions` i `actualReasonCodes`: poprawny `PUBLISH` oraz niepoprawny
structured output mają puste listy, poprawny `REJECT` zachowuje exact lokalnie zwalidowane
findings, a deterministic `PRECHECK` zachowuje wyłącznie code-owned powody i wymiary bez calla
`JUDGE`. Historyczny identyfikator report v2 pozostaje jawny; nie powstał z niego accepted
artifact. Manifest v3 nadal wymaga pełnego `PASS` i wyłącznie poprawnych `SUCCEEDED` operacji.
Validator manifestu odbudowuje kanonicznie cały report, łącznie z nowymi listami E2E, z frozen
datasetu i allowlistowanych primary/repeat/E2E/operation rows; nie ufa zapisanym metrics, gates,
totals ani kosztowi i odrzuca dodatkowe pola. Historyczny identyfikator manifest v2 również
pozostaje jawny, a ten offline hardening nie tworzy accepted manifestu. Privacy-safe failure
przenosi tylko zamknięte metadata, bez raw contentu.
Live `PREFLIGHT_PASSED` emituje workload fingerprint, verified pricing, exact profile i wersje
plan/execution/accounting/cost/retry ceiling. Ten offline fix i wszystkie jego testy wykonują
zero provider calls, kosztują USD 0, nie autoryzują kolejnego baseline i utrzymują Fazę 3B3 w
`REVIEW`.
