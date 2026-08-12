# Przepływ AI

## Stan Fazy 3A

Faza 3A dostarcza bezpieczną granicę integracyjną, ale nie podłącza LLM do `startPlanning`,
CAP ani UI. Gateway jest domyślnie wyłączony. Nie ma produkcyjnych promptów, automatycznych
wywołań ani zapisu runów AI.

Każdy request ma typ zadania, wersję promptu, nazwę i wersję schematu, ugruntowane wejście
JSON oraz lokalny schemat Zod. Gateway tworzy deterministyczny fingerprint wejścia i
wybiera adapter:

1. `DECIDE`, `JUDGE` i `SMOKE` trafiają domyślnie do OpenAI;
2. `GENERATE` trafia domyślnie do Anthropic;
3. jawny override może wskazać jednego providera;
4. błąd nigdy nie uruchamia drugiego providera ani innego modelu;
5. structured output zawsze przechodzi ponowną lokalną walidację.

Adaptery nie otrzymują swobodnego dostępu do danych aplikacji. Wywołujący musi najpierw
zbudować jawny pakiet faktów i zachować informację o brakach. Model nie może uzupełnić
nieznanych cen, źródeł ani dostępności. Nie wykonuje obliczeń finansowych i nie zmienia
twardych ograniczeń.

## Docelowy przepływ

1. Kod waliduje constraints i usuwa niewykonalne kandydatury.
2. Grounding wiąże fakty z `SourceSnapshot` i wykrywa braki.
3. Zadanie decyzyjne klasyfikuje wyłącznie dane o ustalonym schemacie.
4. Zadanie generujące opisuje wybrane przez kod warianty i kompromisy, bez liczenia kosztów.
5. Osobny `JUDGE` kontroluje zgodność, ryzyka i zakazane poluzowanie ograniczeń.
6. Plan dzień po dniu powstaje dopiero po wyborze wariantu.

Prompty będą wersjonowane, a każda zmiana będzie oceniana na stabilnych datasetach,
schematach i rubrykach w `evals/`. Integracja z produktem, trwałe `AiRuns`, prompty i evale
należą do Fazy 3B.
