# Architektura

Backend wykorzystuje SAP CAP 10, TypeScript ESM i lokalny adapter SQLite. Frontend jest osobnym workspace React/Vite z UI5 Web Components for React. Vite przekazuje `/trip-planner` i `/health` do CAP.

## Warstwy backendu

- `domain/` — typy, błędy domenowe i czysta maszyna stanów workflow;
- `validation/` — czysta, testowalna walidacja briefu, hard constraints i soft preferences;
- `orchestration/` — ograniczony pipeline pobierania danych i budowania kandydatów;
- `providers/` — typowane kontrakty providerów oraz stabilne adaptery fixture;
- `ranking/` — budżet, twarde filtrowanie, scoring i wybór zróżnicowanych wariantów;
- serwis CAP — transport OData, trwałość, transakcje i kontrolowane błędy.

## Model briefu i workflow

`TripRequest` przechowuje podstawowy brief oraz status jego potwierdzenia. Pola strukturalne `hardConstraints` i `softPreferences` używają jawnych typów CDS `HardConstraintProfile` i `SoftPreferenceProfile`. Hard constraints nie są swobodnym tekstem: budżet, okna czasowe, limity podróży i dozwolone środki transportu mają typowany kontrakt walidowany przez kod. Soft preferences przechowują wagi całkowite od 1 do 5, natomiast `pace` pozostaje osobnym polem briefu. Wartości domyślne profili pozwalają dotychczasowym klientom nadal tworzyć brief bez przesyłania nowych pól. CAP 10 publikuje te struktury w domyślnym kontrakcie OData jako jawne pola z prefiksami `hardConstraints_*` i `softPreferences_*`; osobny mapper serwisu składa je do zagnieżdżonych typów domenowych i materializuje z powrotem bez zmiany dotychczasowych pól API.

Status `TripRequest` opisuje lifecycle briefu: `DRAFT` oznacza wersję roboczą, a `CONSTRAINTS_CONFIRMED` potwierdzony zestaw ograniczeń. Postęp planowania przechowuje osobna encja `WorkflowRuns`, powiązana jeden-do-jednego z `TripRequest`. Rekord workflow zawiera bieżący stan, kontrolowane informacje o błędzie i znaczniki czasu. Projekcja OData workflow jest tylko do odczytu; klient nie może ominąć maszyny stanów przez bezpośredni zapis. Dzięki temu etap wykonania nie zmienia znaczenia statusu briefu ani zasad jego edycji.

## Maszyna stanów

Dozwolone przejścia są zapisane w czystej funkcji domenowej, niezależnej od CAP i bazy danych:

- `COLLECTING` → `NEEDS_CLARIFICATION` → `CONSTRAINTS_CONFIRMED`;
- `COLLECTING` → `CONSTRAINTS_CONFIRMED`;
- `CONSTRAINTS_CONFIRMED` → `SEARCHING` → `CANDIDATES_VALIDATED` → `OPTIONS_READY`;
- `OPTIONS_READY` → `OPTION_SELECTED` → `ITINERARY_GENERATED` → `VALIDATED` → `READY`;
- `READY` → `REVISING` → `ITINERARY_GENERATED`.

Niedozwolone przejście zgłasza `DomainError` z kodem, stanem źródłowym, stanem docelowym i czytelnym komunikatem. Funkcja zwraca nowy stan dopiero po sprawdzeniu reguły, dlatego błąd nie powoduje częściowej zmiany. W Fazie 2A stany od `SEARCHING` dalej są wyłącznie kontraktem domenowym i przedmiotem testów; wykonywanie tych etapów nie jest jeszcze zaimplementowane.

Akcja `confirmConstraints` waliduje podstawowy brief i oba profile, wymaga statusu `DRAFT`, a następnie w jednej transakcji ustawia status briefu oraz tworzy albo aktualizuje powiązany `WorkflowRun` do `CONSTRAINTS_CONFIRMED`. Błąd w dowolnym kroku wycofuje całą operację. Ponowne potwierdzenie pozostaje niedozwolone.

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

W Fazie 2B pipeline jest czystym modułem aplikacyjnym uruchamianym w testach. Nie ma
jeszcze endpointu CAP uruchamiającego wyszukiwanie, zapisu wyników ani ekranu wariantów.

## Deterministyczny rdzeń i AI

Kod jest jedynym źródłem prawdy dla constraints, przejść workflow, wykonalności i kosztów. Przyszły LLM Gateway otrzyma wyłącznie jawne, ugruntowane dane oraz osobne funkcje decide/generate. Model może później przygotowywać klasyfikacje lub treść, ale nie wybiera, nie zatwierdza i nie zapisuje przejść `WorkflowRun`. Fakty fixture providerów mają już `SourceSnapshot`; przyszłe adaptery zachowają ten sam kontrakt przed wykorzystaniem danych przez model.

## Stos technologiczny

Wersje zostały dobrane dla Node.js 24: CAP 10 oficjalnie rekomenduje Node 24, przechodzi na ESM i Vitest, a Playwright wspiera bieżące linie Node 22/24/26. Używamy TypeScript 6, ponieważ jest najnowszą linią zgodną z zakresem peer dependency bieżącego `typescript-eslint`; TypeScript 7 został świadomie odrzucony zamiast omijania konfliktu. npm 11 zachowuje zgodność z lokalnym Node 24.13. Dokładne wersje są przypięte w `package.json` i `package-lock.json`.
