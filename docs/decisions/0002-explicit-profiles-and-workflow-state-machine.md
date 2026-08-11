# ADR 0002: Jawne profile i domenowa maszyna stanów

- Status: zaakceptowane
- Data: 2026-08-11

## Kontekst

Brief podróży potrzebuje ograniczeń, które można jednoznacznie walidować, oraz preferencji, które później posłużą do oceny dopasowania wariantów. Swobodny tekst nie daje stabilnego kontraktu dla limitu budżetu, okien czasowych, liczby przesiadek, czasu podróży ani dozwolonych środków transportu. Podobnie nie pozwala porównywać znaczenia i siły soft preferences.

Status briefu i postęp jego przetwarzania mają różne cykle życia. `DRAFT` oraz `CONSTRAINTS_CONFIRMED` opisują, czy brief można jeszcze zmieniać, natomiast wyszukiwanie, przygotowanie wariantów, wybór i rewizja opisują wykonanie workflow. Połączenie ich w jednym polu utrudniłoby reguły edycji, obsługę błędów i przyszłe wznowienia procesu.

Przyszłe modele LLM będą pracować na ugruntowanych danych i generować treść. Niedeterministyczny model nie może jednak decydować o spełnieniu hard constraints ani samodzielnie zmieniać trwałego stanu procesu.

## Decyzja

W `TripRequest` osadzamy jawne pola `hardConstraints` i `softPreferences`, oparte odpowiednio na strukturalnych typach CDS `HardConstraintProfile` i `SoftPreferenceProfile`. Każde ograniczenie ma własny typ i walidację, a każda preferencja wagę całkowitą od 1 do 5. `pace` pozostaje osobnym polem. Profile mają poprawne wartości domyślne, aby dotychczasowy formularz i klienci API zachowali kompatybilność.

Domyślna projekcja OData CAP 10 spłaszcza elementy tych struktur do pól `hardConstraints_*` i `softPreferences_*`. Zachowujemy ten stabilny wire contract zamiast zmieniać globalny flavor OData. Jawny mapper na granicy serwisu odpowiada za kontrolowane przejście między płaskim transportem a zagnieżdżonym modelem domenowym.

Status `TripRequest` pozostaje statusem briefu. Stan wykonania przechowujemy w osobnej encji `WorkflowRuns`, powiązanej jeden-do-jednego z `TripRequest` i zawierającej również kontrolowane informacje o błędzie oraz znaczniki czasu. Jej projekcja OData jest tylko do odczytu, aby klient nie mógł ominąć domenowej walidacji przejść.

Dozwolone przejścia `WorkflowRun` definiuje czysta funkcja w kodzie domenowym. Funkcja sprawdza parę stanów przed zwróceniem wyniku, a niedozwolone przejście zgłasza `DomainError` z kodem, stanem źródłowym, stanem docelowym i komunikatem. Serwis zapisuje wynik dopiero po pomyślnej walidacji. W Fazie 2A pełny graf stanów jest kontraktem i może być walidowany, ale wykonywanie etapów od `SEARCHING` dalej pozostaje poza zakresem.

`confirmConstraints` stanowi granicę transakcyjną. Akcja waliduje brief oraz oba profile, wymaga statusu `DRAFT`, ustawia `TripRequest.status` na `CONSTRAINTS_CONFIRMED` i tworzy albo aktualizuje powiązany `WorkflowRun` do tego samego stanu. Niepowodzenie dowolnego kroku wycofuje całą operację.

LLM nie steruje maszyną stanów. Może w przyszłości zwracać wynik zgodny ze schematem lub wygenerowaną treść, ale przejście wybiera, waliduje i utrwala wyłącznie kod aplikacji na podstawie jawnych przesłanek.

## Konsekwencje

Hard constraints i soft preferences są widoczne w kontrakcie, walidowalne bez modelu AI i testowalne bez bazy. Oddzielenie `WorkflowRun` pozwala rozwijać wykonanie procesu bez zmiany znaczenia statusu briefu. Czysta maszyna stanów daje jeden deterministyczny graf przejść wspólny dla serwisu i testów, a transakcja chroni zgodność obu rekordów.

Kosztem jest większy model danych, konieczność jawnego mapowania między płaskim kontraktem OData, strukturalnym CDS i zagnieżdżonym TypeScript oraz utrzymywanie testów kontraktu i rollbacku. Dodanie nowego stanu lub pola profilu wymaga świadomej zmiany domeny, walidacji, testów i dokumentacji. Samo istnienie stanu w grafie nie oznacza, że odpowiadający mu etap workflow został już zaimplementowany.
