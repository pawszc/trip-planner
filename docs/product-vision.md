# Wizja produktu

## Problem użytkownika

Planowanie krótkiej podróży wymaga pogodzenia terminów, budżetu, liczby osób,
ograniczeń transportu i preferencji z dostępnymi opcjami. Zwykły chatbot może stworzyć
przekonujący tekst, ale nie gwarantuje wykonalności, poprawnych kosztów ani pochodzenia
faktów.

## Wartość

Trip Planner zbiera twarde ograniczenia i miękkie preferencje, odrzuca niewykonalne
kandydatury stabilnym kodem, deterministycznie liczy koszty i przedstawia dokładnie trzy
różne role: `BEST_OVERALL`, `MOST_CONVENIENT` i `BEST_VALUE`. Użytkownik widzi całkowity
koszt i koszt na osobę, klasyfikację confirmed/estimated/unknown, komponenty score,
kompromisy, ryzyka, źródła oraz diagnostykę odrzuceń.

## Stan po Fazie 2

Kompletny przepływ brief → potwierdzenie constraints → planowanie → opcje działa lokalnie
na wersjonowanych fixture'ach. Wynik jest trwały, powiązany z briefem i konkretnym runem,
ma wersję providerów oraz scoringu i jest idempotentny. Brak trzech wariantów nie powoduje
poluzowania constraints ani zapisania częściowych kart.

Fixture `INTERNAL_FIXTURE` jest zawsze opisane jako dane demonstracyjne. Produkt nie
sugeruje, że jest to aktualna oferta lub potwierdzona dostępność.

Fixture Fazy 2 jest w interfejsie jawnie ograniczone do demonstracyjnego scenariusza
rozpoczynającego się we Wrocławiu. Zapisany `DRAFT` można poprawić przed potwierdzeniem, a
po `INSUFFICIENT_OPTIONS` rozpocząć nowy brief z kopią obecnych danych bez zmiany starego.

## Stan po Fazie 3B2

Użytkownik API może jawnie zażądać narracji dla jednej z opcji już wybranych przez kod.
Model otrzymuje wersjonowany grounded context z dokładnymi fact IDs, źródłami i jawnymi
brakami. Każdy zwalidowany blok tekstu musi wskazać co najmniej jeden fakt z dokładnego
kontekstu, a błąd AI lub walidacji nie zmienia karty, rankingu, constraints ani budżetu.

Akcja pozostaje domyślnie wyłączona przez `AI_ENABLED=false` i nie jest jeszcze podłączona
do UI. Same poprawne referencje dają traceability, ale bez przyszłego `JUDGE` nie stanowią
semantycznego dowodu groundedness tekstu.

## Stan Fazy 3B3 (`REVIEW`)

Narracja nie może już zostać opublikowana wyłącznie dlatego, że ma poprawny schemat i
referencje. Provider `GENERATE` otrzymuje minimalny model-safe view bez raw source URLs,
external IDs i zbędnych nieufnych wartości. Zwalidowany kandydat przechodzi deterministyczny
format/safety precheck, a następnie jeden ścisły `JUDGE`, który ocenia osiem wersjonowanych
wymiarów groundedness, constraints, money/time, provenance i safety. Ostateczne
`PUBLISH`/`REJECT` wylicza kod, nie model.

Odrzucenie zapisuje wyłącznie bezpieczne metadata review i nie utrwala tekstu kandydata.
Akceptacja wymaga dwóch dokładnych terminalnych audytów i atomowo zapisuje review oraz tekst
oceniony byte-for-byte. Żadna awaria nie zmienia wariantu, rankingu, constraints ani
budżetu. Akcja nadal jest ręczna, domyślnie wyłączona i nieobecna w UI.

Synthetic frozen dataset, metryki i offline harness zapewniają odtwarzalny quality gate bez
credentiali, sieci i kosztu. Finalny live baseline wymaga osobnej zgody i limitów 48 calls,
56 attempts oraz USD 3.00. Nie został wykonany; koszt implementacji wynosi USD 0 i faza nie
jest `DONE`.

## Różnica wobec chatbota

Model językowy nie może poluzować ograniczeń, wymyślić brakującej ceny ani wykonać
arytmetyki finansowej. W Fazie 2 LLM nie jest używany w ogóle; w Fazie 3B3 pracuje dopiero
na wyniku kodu i minimalnym model-safe view, a jego tekst jest fail-closed oceniany przed
publikacją. Szczegółowy plan dzień po dniu powstanie dopiero po świadomym wyborze wariantu
przez użytkownika.
