# Architektura

Backend wykorzystuje SAP CAP 10, TypeScript ESM i lokalny adapter SQLite. Frontend jest osobnym workspace React/Vite z UI5 Web Components for React. Vite przekazuje `/trip-planner` i `/health` do CAP.

## Warstwy backendu

- `domain/` — typy, błędy domenowe i czysta maszyna stanów workflow;
- `validation/` — czysta, testowalna walidacja briefu, hard constraints i soft preferences;
- `orchestration/` — przyszła koordynacja wykonywania etapów planowania;
- `providers/` — przyszłe adaptery usług zewnętrznych;
- `ranking/` — przyszłe filtrowanie i ranking wariantów;
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

## Deterministyczny rdzeń i AI

Kod jest jedynym źródłem prawdy dla constraints, przejść workflow, wykonalności i kosztów. Przyszły LLM Gateway otrzyma wyłącznie jawne, ugruntowane dane oraz osobne funkcje decide/generate. Model może później przygotowywać klasyfikacje lub treść, ale nie wybiera, nie zatwierdza i nie zapisuje przejść `WorkflowRun`. Fakty providerów będą utrwalane jako `SourceSnapshot` przed wykorzystaniem przez model.

## Stos technologiczny

Wersje zostały dobrane dla Node.js 24: CAP 10 oficjalnie rekomenduje Node 24, przechodzi na ESM i Vitest, a Playwright wspiera bieżące linie Node 22/24/26. Używamy TypeScript 6, ponieważ jest najnowszą linią zgodną z zakresem peer dependency bieżącego `typescript-eslint`; TypeScript 7 został świadomie odrzucony zamiast omijania konfliktu. npm 11 zachowuje zgodność z lokalnym Node 24.13. Dokładne wersje są przypięte w `package.json` i `package-lock.json`.
