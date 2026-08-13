# Przepływ AI

## Stan Fazy 3B1

Faza 3B1 przygotowuje bezpieczny fundament wykonania, ale nadal nie podłącza LLM do
`startPlanning`, żadnej akcji CAP ani UI. `AI_ENABLED=false` jest defaultem. Nie ma
produkcyjnych promptów, automatycznych wywołań ani ręcznego wywołania AI z produktu.

Każdy normalny request wskazuje `DECIDE`, `GENERATE` lub `JUDGE`. Gateway wybiera wyłącznie
skonfigurowany profil zadania; request nie może zmienić providera, modelu ani effort i może
tylko obniżyć limit output tokens. Operator smoke jest oddzielną ścieżką, nie provider
override w requestcie produktu.

## Lifecycle pojedynczego wykonania

1. Gateway sprawdza opt-in `AI_ENABLED` przed fingerprintem i jakimkolwiek audytem.
2. Wybiera pełny profil zadania i adapter tego providera.
3. Tworzy SHA-256 fingerprint ugruntowanego JSON oraz UUID `aiRunId`.
4. Asynchroniczny recorder utrwala `STARTED` w krótkiej transakcji CAP.
5. Dopiero po sukcesie `STARTED` adapter wykonuje request bez otwartej transakcji bazy.
6. Adapter lokalnie waliduje structured output i zwraca oba identyfikatory modelu.
7. Gateway waliduje provider, configured model, task, wersje, fingerprint, UUID i response
   model.
8. Recorder aktualizuje ten sam rekord do `SUCCEEDED`; dopiero wtedy output może wrócić.
9. Po błędzie adaptera recorder aktualizuje ten sam rekord do `FAILED`; dopiero wtedy wraca
   znormalizowany błąd.

Na SQLite ten lifecycle nie może zaczynać się wewnątrz rozpoczętej transakcji DB requestu,
bo niezależny audit czekałby na jedyne połączenie trzymane przez outer request. Store
odrzuca taki układ fail-closed. Produktowy handler 3B2 musi użyć faz:
`krótki read i commit → audit/provider/audit → osobny krótki product write`.

Recorder jest fail-closed. Błąd dowolnego wymaganego zapisu kończy się
`AI_AUDIT_FAILED`. Brak trwałego `STARTED` bezwzględnie blokuje request do providera, a brak
trwałego `SUCCEEDED` blokuje użycie poprawnego outputu.

`AiRuns` przechowuje tylko metadane wykonania i retencję. Prompt, instrukcje, wejście,
output i surowe błędy nigdy nie są utrwalane. Encja jest wewnętrzna i nie ma endpointu
OData. Cleanup ma testowalny kontrakt `deleteExpired(now)`, ale nie ma jeszcze schedulera.

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

Faza 3B2 doda grounded option context, wersjonowane prompty i narracje do wybranych opcji.
Faza 3B3 doda wykonywanie `JUDGE`, safety pipeline oraz offline/płatne opt-in evale. Żaden z
tych elementów nie jest wykonywany w 3B1.
