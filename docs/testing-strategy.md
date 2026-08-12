# Strategia testów

## Poziomy testów

### Testy jednostkowe

Uruchamiają czystą domenę bez UI i bazy. Obejmują:

- walidację briefu, hard constraints i każdej wagi soft preferences;
- ścisłe daty kalendarzowe, w tym daty nieistniejące i poprawne lata przestępne;
- wszystkie dozwolone przejścia workflow i reprezentatywne przejścia niedozwolone;
- `Money`, wszystkie `PriceType`, UNKNOWN, waluty i bezpieczne minor units;
- 13 kodów odrzucenia, wiele powodów, deduplikację i granice buildera;
- komponenty score, stabilny tie-breaker i diversity selection;
- kontrolowany niedobór dwóch lub zera opcji;
- dokładną konwersję major → minor units bez arytmetyki floating point;
- mapowanie awarii providera na kontrolowany kod bez ujawnienia jego komunikatu.
- konfigurację LLM Gateway, routing z override, brak fallbacku i blokadę `AI_DISABLED`;
- kontrakty rzeczywistych wywołań obu oficjalnych SDK przez transport HTTP in-memory;
- structured outputs, ponowną lokalną walidację, refusal i brak poprawnej treści;
- timeout, retry, zamknięty katalog błędów oraz redakcję kluczy i nagłówków;
- blokadę live smoke, brak credentiali i dokładnie jedno wywołanie po jawnym opt-in.

Scenariusz referencyjny 2B wymaga dokładnie 28 zbudowanych, 6 poprawnych i 22
odrzuconych kandydatów. Wynik to Praga `BEST_OVERALL`, Wiedeń `MOST_CONVENIENT` i
Budapeszt `BEST_VALUE`, identyczne przy ponownym uruchomieniu.

### Testy integracyjne

Uruchamiają prawdziwy serwer CAP z SQLite in-memory i testują kontrakt OData. Faza 2C
sprawdza między innymi:

- odrzucenie `startPlanning` dla brakującego briefu i statusu `DRAFT`;
- sukces dla `CONSTRAINTS_CONFIRMED`;
- audyt kolejności `SEARCHING` → `CANDIDATES_VALIDATED` → `OPTIONS_READY`;
- zapis dokładnie trzech ról i wszystkich powiązań do trip/workflow/planning run;
- wersje `europe-reference-v1`, engine i scoringu;
- 22 odrzuconych kandydatów, szczegóły i 13 grup kodów;
- znormalizowane `SourceSnapshots`, `BudgetBreakdowns` i 7 `BudgetItems` na opcję;
- zgodność sum confirmed/estimated/unknown z agregatem karty;
- idempotentne ponowne wywołanie bez duplikatów;
- dwa równoległe wywołania `startPlanning` koaleskowane do jednego pipeline'u i runu;
- kontrolowany niedobór z diagnostyką i zerem częściowych opcji;
- rollback wszystkich zapisów po awarii providera.

### Playwright

Dwa stabilne scenariusze Chromium przechodzą oba wyniki planowania. Pierwszy obejmuje
formularz, edycję zapisanego `DRAFT`, wszystkie ważne constraints i preferences,
potwierdzenie, planowanie, dokładnie trzy karty, role, koszt, transport, źródła fixture,
budżet i diagnostykę odrzuceń. Drugi wymusza `INSUFFICIENT_OPTIONS`, sprawdza brak
częściowych kart oraz utworzenie nowego briefu z obecnych danych. Testy używają etykiet i
stabilnych `data-testid`, ustawiają suwaki klawiaturą, sprawdzają brak błędów konsoli, a
scenariusz referencyjny także widok 390×844 bez poziomego overflow.

Test nie kontaktuje się z internetem, nie korzysta z zegara systemowego i używa stałych dat
`2026-10-10`–`2026-10-13`. Przy błędzie zachowuje screenshot, trace i raport HTML.

## Weryfikacja

`npm run verify` uruchamia lint, typecheck, unit, integration i build. `npm run verify:full`
uruchamia ten sam zestaw oraz E2E. Przed zakończeniem pracy wymagany jest `verify`, a przed
PR — `verify:full`. Testów nie wyłącza się, nie pomija i nie rozwadnia w celu uzyskania
zielonego wyniku.

Testy adapterów nie patchują globalnego `fetch`: fabryka klienta otrzymuje lokalny,
kontrolowany transport, który pozwala sprawdzić rzeczywisty payload SDK bez sieci. Żaden
test w `test`, `verify` ani `verify:full` nie wymaga credentiali i nie wykonuje płatnego
requestu.

## Manualny smoke test AI

`npm run ai:credentials:check` wykonuje wyłącznie lokalną kontrolę obecności wymaganych
zmiennych i wypisuje bezpieczne statusy bez wartości sekretów. `npm run ai:smoke:openai` i
`npm run ai:smoke:anthropic` wymagają `AI_LIVE_SMOKE_ENABLED=true` oraz klucza wybranego
providera. Każdy skrypt wykonuje dokładnie jedno minimalne wywołanie o strukturalnym
wyniku. `npm run ai:smoke` uruchamia je sekwencyjnie.

Smoke testy są celowo poza CI i standardową weryfikacją, ponieważ są płatne, zależą od
zewnętrznej dostępności i uprawnień konta. Nie wolno ich uruchamiać automatycznie ani
używać do omijania testów offline. Evale LLM nie zastąpią testów twardych reguł,
persistence ani arytmetyki kodu.
