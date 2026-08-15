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

## Różnica wobec chatbota

Model językowy nie poluzuje ograniczeń, nie wymyśli brakującej ceny i nie wykona
arytmetyki finansowej. W Fazie 2 LLM nie jest używany w ogóle. Przyszła warstwa AI może
pracować dopiero na wynikach kodu i źródłach, a szczegółowy plan dzień po dniu powstanie
dopiero po świadomym wyborze wariantu przez użytkownika.
