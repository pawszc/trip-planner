# Architektura

Backend wykorzystuje SAP CAP 10, TypeScript ESM i lokalny adapter SQLite. Frontend jest osobnym workspace React/Vite z semantycznymi, dostępnymi kontrolkami HTML. Vite przekazuje `/trip-planner` i `/health` do CAP.

## Warstwy backendu

- `domain/` — typy, błędy domenowe i czysta maszyna stanów workflow;
- `validation/` — czysta, testowalna walidacja briefu, hard constraints i soft preferences;
- `orchestration/` — ograniczony pipeline pobierania danych i budowania kandydatów;
- `providers/` — typowane kontrakty providerów oraz stabilne adaptery fixture;
- `ai/` — vendor-neutral kontrakty LLM, routing, adaptery SDK, lokalna walidacja,
  redakcja i bezpieczna telemetria;
- `ranking/` — budżet, twarde filtrowanie, scoring i wybór zróżnicowanych wariantów;
- `persistence/` — kontrolowane mapowanie wyników domenowych na znormalizowane rekordy;
- serwis CAP — transport OData, trwałość, transakcje i kontrolowane błędy.

## Model briefu i workflow

`TripRequest` przechowuje podstawowy brief oraz status jego potwierdzenia. Pola strukturalne `hardConstraints` i `softPreferences` używają jawnych typów CDS `HardConstraintProfile` i `SoftPreferenceProfile`. Hard constraints nie są swobodnym tekstem: budżet, okna czasowe, limity podróży i dozwolone środki transportu mają typowany kontrakt walidowany przez kod. Soft preferences przechowują wagi całkowite od 1 do 5, natomiast `pace` pozostaje osobnym polem briefu. Wartości domyślne profili pozwalają dotychczasowym klientom nadal tworzyć brief bez przesyłania nowych pól. CAP 10 publikuje te struktury w domyślnym kontrakcie OData jako jawne pola z prefiksami `hardConstraints_*` i `softPreferences_*`; osobny mapper serwisu składa je do zagnieżdżonych typów domenowych i materializuje z powrotem bez zmiany dotychczasowych pól API.

Daty briefu przechodzą przez jedną funkcję `parseStrictIsoDate`, która wymaga dokładnego
formatu `YYYY-MM-DD` i istniejącego dnia kalendarzowego. Ten sam walidator jest wykonywany
przy CREATE, UPDATE, `confirmConstraints` i `startPlanning`; round-trip UTC odrzuca między
innymi 29 lutego w roku nieprzestępnym oraz nieistniejące dni miesiąca.

Status `TripRequest` opisuje lifecycle briefu: `DRAFT` oznacza wersję roboczą, a `CONSTRAINTS_CONFIRMED` potwierdzony zestaw ograniczeń. Postęp planowania przechowuje osobna encja `WorkflowRuns`, powiązana jeden-do-jednego z `TripRequest`. Rekord workflow zawiera bieżący stan, kontrolowane informacje o błędzie i znaczniki czasu. Projekcja OData workflow jest tylko do odczytu; klient nie może ominąć maszyny stanów przez bezpośredni zapis. Dzięki temu etap wykonania nie zmienia znaczenia statusu briefu ani zasad jego edycji.

Każde deterministyczne wykonanie ma osobny `PlanningRun`, powiązany z `TripRequest` i
`WorkflowRun`. Run zapisuje fingerprint pełnego wejścia, wersję fixture providerów, wersję
silnika i scoringu, liczniki kandydatów oraz kontrolowany status. Unikalność fingerprintu
zapewnia idempotencję dla nieedytowalnego, potwierdzonego briefu.

Równoległe wywołania `startPlanning` dla tego samego briefu są koaleskowane przez serwis do
jednego aktywnego wykonania. Pierwszy request jest właścicielem transakcji, a kolejne czekają
na jego commit i otrzymują ten sam wynik. Wpis single-flight jest usuwany dopiero w fazie
`done` requestu; unikalność fingerprintu w bazie nadal chroni trwały zapis przed duplikatami.

## Maszyna stanów

Dozwolone przejścia są zapisane w czystej funkcji domenowej, niezależnej od CAP i bazy danych:

- `COLLECTING` → `NEEDS_CLARIFICATION` → `CONSTRAINTS_CONFIRMED`;
- `COLLECTING` → `CONSTRAINTS_CONFIRMED`;
- `CONSTRAINTS_CONFIRMED` → `SEARCHING` → `CANDIDATES_VALIDATED` → `OPTIONS_READY`;
- `OPTIONS_READY` → `OPTION_SELECTED` → `ITINERARY_GENERATED` → `VALIDATED` → `READY`;
- `READY` → `REVISING` → `ITINERARY_GENERATED`.

Niedozwolone przejście zgłasza `DomainError` z kodem, stanem źródłowym, stanem docelowym i czytelnym komunikatem. Funkcja zwraca nowy stan dopiero po sprawdzeniu reguły, dlatego błąd nie powoduje częściowej zmiany. `startPlanning` wykonuje pierwsze trzy przejścia planowania w jednej transakcji i utrwala ich kolejność w `WorkflowTransitions`.

Akcja `confirmConstraints` waliduje podstawowy brief i oba profile, wymaga statusu `DRAFT`, a następnie w jednej transakcji ustawia status briefu oraz tworzy albo aktualizuje powiązany `WorkflowRun` do `CONSTRAINTS_CONFIRMED`. Błąd w dowolnym kroku wycofuje całą operację. Ponowne potwierdzenie pozostaje niedozwolone.

Akcja `startPlanning` ponownie waliduje cały brief i profile, tworzy kontekst w integer
minor units, wywołuje providery przez interfejsy 2B i uruchamia pipeline. Providerzy są
wywoływani przed pierwszym zapisem. Udany wynik zapisuje atomowo run, przejścia, dokładnie
trzy opcje, budżety, źródła, notatki i odrzucenia. Awaria providera zwraca kontrolowane
`PROVIDER_SEARCH_FAILED` i pozostawia workflow w `CONSTRAINTS_CONFIRMED` bez wyników.

## Deterministyczny silnik kandydatów

Faza 2B wprowadza trzy interfejsy graniczne: `TransportProvider`,
`AccommodationProvider` i `PlacesProvider`. Requests zawierają wyłącznie jawny kontekst
podróży, a wyniki używają typów domenowych. Kod domenowy i ranking nie znają schematu
żadnego konkretnego API. Obecne implementacje mock korzystają wyłącznie z
wersjonowanych fixture'ów generowanych względem dat briefu, dlatego nie zależą od
internetu ani zegara systemowego.

Kwoty są dyskryminowaną unią `Money`: znane ceny przechowują bezpieczną całkowitą
liczbę minor units, natomiast `UNKNOWN` ma `amountMinor: null`. Każda cena ma
`PriceType` i `SourceSnapshot`. Reguły kosztów lokalnych są estymacjami z własnym,
wersjonowanym snapshotem `INTERNAL_FIXTURE`. Silnik nie wykonuje przewalutowania;
inna waluta powoduje odrzucenie kandydata.

Candidate builder tworzy wariant z destynacji, transportu, noclegu i kosztów lokalnych.
Konfigurowalne limity liczby transportów, noclegów oraz kandydatów na destynację
zapobiegają nieograniczonemu iloczynowi kartezjańskiemu. Następnie filtr zbiera wszystkie
powody odrzucenia, w tym naruszenia godzin, czasu podróży, środka transportu, budżetu,
źródeł, waluty, kompletności i duplikacji. Niewykonalny kandydat nigdy nie trafia do
scoringu.

Domyślna wersja `candidate-engine-v1` ogranicza fan-out do 12 destynacji, 6 transportów,
6 noclegów, 20 miejsc oraz 24 kandydatów na destynację. Limity można obniżyć jawną
konfiguracją i są walidowane jako nieujemne, bezpieczne liczby całkowite. Minimalny
efektywny czas na miejscu wynosi 24 godziny. `maxTravelMinutes` jest interpretowane jako
limit każdego odcinka podróży osobno, czyli dłuższego z przejazdu w obie strony. Gdy
constraint nie jest podany, filtr nie wprowadza ukrytego limitu; domyślne 12 godzin
służy wyłącznie do normalizacji komponentu scoringowego `travelTime`.

Zamknięty katalog powodów odrzucenia obejmuje:

- `BUDGET_EXCEEDED`, `DEPARTURE_TOO_EARLY`, `RETURN_TOO_LATE`;
- `TOO_MANY_CONNECTIONS`, `TRANSPORT_MODE_NOT_ALLOWED`, `TRAVEL_TIME_EXCEEDED`;
- `REQUIRED_PRICE_UNKNOWN`, `SOURCE_MISSING`, `CURRENCY_MISMATCH`;
- `DUPLICATE_CANDIDATE`, `INSUFFICIENT_TIME_AT_DESTINATION`, `INVALID_DATES`,
  `INCOMPLETE_DATA`.

Kalkulator `internal-cost-estimates-v1` używa stawek w minor units na osobę i dzień:
2 000 na transport lokalny, 8 000 na wyżywienie i 4 000 na atrakcje. Dzień wyjazdu i
powrotu są wliczone. Bufor wynosi 10% znanego podsumowania i jest zaokrąglany w górę do
pełnego minor unit. `BudgetBreakdown` osobno sumuje kwoty potwierdzone i estymowane;
jeśli dowolna wymagana kategoria jest `UNKNOWN` albo ma inną walutę, koszt całkowity,
koszt na osobę i pozostały budżet mają wartość `null`.

Score ma zakres 0–100 i wersję zapisaną w kodzie. Jest ważoną średnią komponentów:
`budgetFit` 20%, `travelTime` 15%, `effectiveTimeAtDestination` 15%,
`accommodationLocation` 15%, `dataCompleteness` 10%, `priceConfidence` 10% oraz
`deterministicPreferenceFit` 15%. Stabilny tie-breaker zapewnia identyczną kolejność
przy ponownym uruchomieniu. Diversity selection przypisuje role `BEST_OVERALL`,
`MOST_CONVENIENT` i `BEST_VALUE`, preferuje różne destynacje i nigdy nie powtarza tej
samej kombinacji transportu z hotelem. Przy mniej niż trzech poprawnych kandydatach
zwraca jawny niedobór bez poluzowania constraints.

Komponenty są jawnie obliczane następująco, zawsze z ograniczeniem do 0–100:

- `budgetFit = (1 - total / budgetLimit) × 100`;
- `travelTime = (1 - longestLeg / maxTravelMinutes) × 100`;
- `effectiveTimeAtDestination = effectiveMinutes / requestedWindowMinutes × 100`;
- `accommodationLocation` pochodzi z ugruntowanego `centralityScore` noclegu;
- `dataCompleteness` jest udziałem spełnionych kontroli kompletności;
- `priceConfidence = (confirmed + 0,7 × estimated) / total × 100`;
- `deterministicPreferenceFit` jest średnią dopasowań ważoną wagami 1–5 z briefu.

`BEST_OVERALL` używa całkowitego score. `MOST_CONVENIENT` porządkuje pozostałe
kandydatury według `0,40 × travelTime + 0,35 × effectiveTimeAtDestination + 0,25 ×
accommodationLocation`, a `BEST_VALUE` według `0,65 × budgetFit + 0,35 ×
priceConfidence`. Każda kolejna rola najpierw szuka niewykorzystanej destynacji i zawsze
odrzuca wykorzystaną już semantyczną kombinację transportu z hotelem.

Fixture `europe-reference-v1` zawiera 8 destynacji, 16 transportów, 11 noclegów i 12
miejsc. Dla referencyjnego briefu daje 28 kandydatów: 6 poprawnych i 22 jawnie
odrzucone. Stabilny wybór to Praga jako `BEST_OVERALL`, Wiedeń jako
`MOST_CONVENIENT` i Budapeszt jako `BEST_VALUE`.

Faza 2C integruje ten sam czysty pipeline z CAP i UI bez zmiany zasad rankingu. Surowe
payloady providerów nie są zapisywane. `RankedOptions` zawierają wyłącznie wybrane fakty
domenowe i komponenty score; `BudgetItems` zachowują kategorię, price type i klasyfikację;
`SourceSnapshots` przechowują kontrolowany kontrakt pochodzenia. `OptionNotes` powstają z
deterministycznych szablonów.

Przy mniej niż trzech poprawnych wariantach zapisuje się `PlanningRun` ze statusem
`INSUFFICIENT_OPTIONS`, diagnostyki `RejectionReasons` i `RejectionSummaries`, ale zero
`RankedOptions`. `WorkflowRun` pozostaje w `CONSTRAINTS_CONFIRMED`. Ponowne wywołanie dla
tego samego fingerprintu zwraca ten sam run i nie tworzy duplikatów.

UI pozwala poprawić zapisany `DRAFT` przez PATCH przed potwierdzeniem. Po kontrolowanym
niedoborze użytkownik może utworzyć nowy, edytowalny brief skopiowany z obecnych danych;
potwierdzony brief i jego diagnostyka pozostają niezmienne. Widok jawnie opisuje fixture
Fazy 2 jako demonstracyjny scenariusz rozpoczynający się we Wrocławiu, bez aktualnych ofert
ani potwierdzonej dostępności.

## Publiczny kontrakt CAP

Bound actions na `TripRequests`:

- `confirmConstraints()` — zatwierdza brief;
- `startPlanning()` — zwraca wersjonowany `PlanningRun`.

Projekcje tylko do odczytu: `WorkflowRuns`, `PlanningRuns`, `WorkflowTransitions`,
`RankedOptions`, `BudgetBreakdowns`, `BudgetItems`, `SourceSnapshots`, `OptionNotes`,
`RejectionReasons` i `RejectionSummaries`. Klient pobiera zbiory filtrem po
`tripRequest_ID` albo `planningRun_ID`; nie może bezpośrednio zmienić workflow ani wyników.

## Deterministyczny rdzeń i LLM Gateway

Kod pozostaje jedynym źródłem prawdy dla constraints, przejść workflow, wykonalności,
scoringu i arytmetyki finansowej. Gateway Fazy 3A nie jest jeszcze wywoływany przez CAP ani
UI. Przyjmuje wyłącznie jawne, ugruntowane wejście JSON oraz schemat Zod, a zwraca
zwalidowany wynik wraz z vendor-neutral metadanymi użycia.

`AiGateway` rozdziela `DECIDE`, `JUDGE` i `SMOKE` do providera decyzyjnego, a
`GENERATE` do providera generującego. Jawny override providera działa tylko na poziomie
pojedynczego requestu. Brak adaptera, wyłączony gateway lub błąd dostawcy kończą się
kontrolowanym błędem; nie ma cichego fallbacku między providerami ani modelami.

Adapter OpenAI używa Responses API oraz structured outputs. Adapter Anthropic używa
Messages API i structured outputs. Oba korzystają z oficjalnych SDK, ale typy SDK nie
przechodzą poza warstwę adaptera. Wynik jest ponownie walidowany lokalnie przez Zod, nawet
gdy provider deklaruje zgodność ze schematem. Klient SDK powstaje leniwie dopiero przy
wywołaniu, dlatego import, build, testy i standardowy start nie wymagają kluczy.

Gateway rejestruje tylko kontrolowane metadane: provider, model, typ zadania, wersje,
fingerprint wejścia, czas, próby, tokeny i status cache. Nie zapisuje promptów, pełnego
wejścia, pełnego wyjścia, nagłówków ani sekretów. Persystencja `AiRuns` jest odłożona do
Fazy 3B.

## Stos technologiczny

Wersje zostały dobrane dla Node.js 24: CAP 10 oficjalnie rekomenduje Node 24, przechodzi na ESM i Vitest, a Playwright wspiera bieżące linie Node 22/24/26. Używamy TypeScript 6, ponieważ jest najnowszą linią zgodną z zakresem peer dependency bieżącego `typescript-eslint`; TypeScript 7 został świadomie odrzucony zamiast omijania konfliktu. npm 11 zachowuje zgodność z lokalnym Node 24.13. Dokładne wersje są przypięte w `package.json` i `package-lock.json`.
