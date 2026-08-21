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
network-free kalkulacją tego samego planu oraz kosztu: aktualny profil Terra ma ceiling
6,950,969 USD micros i przekracza cap, natomiast porównawczy profil Luna ma ceiling 1,056,177
USD micros i mieści się w cap. Porównanie nie zmienia runtime defaultu Terra ani nie
autoryzuje zmiany modelu. Produkcyjny `npm run eval:live` nadal wymaga obu opt-inów,
credentiali i przejścia wszystkich limitów; dopiero wtedy wdraża odizolowany, ignorowany
przez Git store `.tools/narrative-live-eval/` z bezpiecznymi metadata `AiRuns`. Baseline nie
został uruchomiony; rzeczywisty koszt wynosi USD 0, dlatego Faza 3B3 pozostaje `REVIEW`.
