# Evals

Ten katalog przechowuje frozen kontrakty narrative-quality Fazy 3B3. `datasets/`,
`schemas/` i `rubrics/` opisują odpowiednio syntetyczne przypadki, maszynowy kontrakt danych
i kryteria jakości. Implementacja loadera, metryk, offline harnessu, privacy-safe raportów,
baseline binding, price arithmetic i live guard znajduje się w `srv/evals/`.

Offline eval jest deterministyczny, credential-free i należy do standardowej weryfikacji.
Nie wykonuje sieci ani paid calls i nie zastępuje testów twardych reguł, persistence lub
arytmetyki domenowej.

Finalny live baseline używa wyłącznie danych syntetycznych, jest poza CI i wymaga osobnej
zgody, `AI_LIVE_EVAL_ENABLED=true`, przejścia preflightu oraz limitów 48 logical calls, 56
provider attempts i USD 3.00. Plan v1 ma dokładnie 46 calls i wymaga
`AI_MAX_RETRIES=0`; wersjonowany katalog cen celowo nie zgaduje stawek dla skonfigurowanych
modeli, dlatego obecnie blokuje preflight. Dopiero po pełnym preflight runner wdraża
odizolowany, ignorowany przez Git store `.tools/narrative-live-eval/` zawierający wyłącznie
bezpieczne metadata `AiRuns`. Baseline nie został uruchomiony podczas
implementacji; rzeczywisty koszt wynosi USD 0, dlatego Faza 3B3 pozostaje `REVIEW`.
