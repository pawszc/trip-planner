# ADR 0003: Mock providerzy i deterministyczny silnik kandydatów

- Status: zaakceptowane
- Data: 2026-08-11

## Kontekst

Po potwierdzeniu briefu aplikacja potrzebuje stabilnej granicy pobierania danych oraz
powtarzalnego sposobu budowania, odrzucania i porządkowania wariantów. Rdzeń domenowy
nie może zależeć od formatu konkretnego API ani od bieżącej dostępności sieci. Koszty,
twarde ograniczenia i wybór wariantów nie mogą być delegowane do LLM.

Kwoty z ofert i estymacji muszą być sumowane bez błędów binarnego `floating point`.
Brak ceny jest informacją biznesową, a nie zerem. Dane z różnych walut nie są
porównywalne bez jawnego mechanizmu FX, którego nie ma jeszcze w MVP.

## Decyzja

### Granica providerów

Wprowadzamy trzy małe interfejsy: `TransportProvider`, `AccommodationProvider` i
`PlacesProvider`. Każdy otrzymuje własny, jawnie typowany request i zwraca domenowe
wyniki niezależne od formatu zewnętrznego API. Adapter odpowiada za translację danych
źródłowych; candidate engine zna wyłącznie kontrakt domenowy.

Faza 2B dostarcza implementacje `MockTransportProvider`,
`MockAccommodationProvider` i `MockPlacesProvider`. Korzystają one z wersjonowanych,
lokalnych fixture'ów, generują znaczniki czasu względem dat briefu i nigdy nie używają
bieżącej daty systemowej ani internetu. Fixture'y zawierają zarówno poprawne dane, jak
i celowo uszkodzone przypadki potrzebne do testowania każdego filtra.

### Pieniądze i źródła

Kwoty zapisujemy jako całkowite minor units wraz z walutą i `PriceType`. Dla PLN 1250
oznacza 12,50 PLN. Znana kwota musi być nieujemną bezpieczną liczbą całkowitą. Cena
`UNKNOWN` ma `amountMinor: null`; silnik nie podkłada pod nią zera ani estymacji.

Model wejścia i persistence używa `Decimal(13, 2)`, dlatego zamknięty kontrakt
`currency-fraction-digits-v1` obsługuje wyłącznie jawnie wymienione waluty dwucyfrowe:
`PLN` i `EUR`, obie z `fractionDigits: 2`. Ten sam kontrakt jest używany przez walidację
`TripRequest`, konwersję major → minor, domenę `Money`, provider requesty i późniejsze
formatowanie grounded display. Poprawny składniowo, ale niewymieniony kod jest odrzucany.
Obsługa JPY, KWD lub innej liczby cyfr ułamkowych wymaga najpierw szerszej zmiany modelu
budżetowego, a nie lokalnego wyjątku w formatterze.

Każda cena i każdy fakt providera wskazują `SourceSnapshot`. Wewnętrzne estymacje
również otrzymują snapshot z nazwą i wersją reguły oraz oznaczeniem
`INTERNAL_FIXTURE`. Pozwala to odróżnić cenę potwierdzoną, estymowaną i nieznaną oraz
odtworzyć pochodzenie wyniku.

Nie wykonujemy przewalutowania w Fazie 2B. Każdy koszt w walucie innej niż waluta
briefu otrzymuje `CURRENCY_MISMATCH` i nie może przejść do rankingu.

### Pipeline kandydatów

Candidate builder łączy destynację, transport, nocleg i wersjonowane estymacje kosztów
lokalnych. Nie tworzy nieograniczonego iloczynu kartezjańskiego: osobna konfiguracja
ogranicza liczbę transportów, noclegów i wynikowych kandydatów na destynację.

Kolejność przetwarzania jest stała:

1. pobranie typowanych wyników providerów;
2. ograniczone i stabilnie uporządkowane zbudowanie kandydatów;
3. zebranie wszystkich powodów odrzucenia dla każdego kandydata;
4. usunięcie niewykonalnych i semantycznych duplikatów;
5. deterministyczne obliczenie budżetu oraz komponentów score;
6. stabilny ranking z jawnym tie-breakerem;
7. wybór zróżnicowanych ról `BEST_OVERALL`, `MOST_CONVENIENT` i `BEST_VALUE`.

Filtrowanie zawsze poprzedza ranking. Scoring nie może kompensować naruszenia hard
constraint, braku wymaganego źródła, nieznanej wymaganej ceny ani niezgodnej waluty.
Brak wymaganej ceny jest odrzucany również przy miękkim budżecie, ponieważ nie może
zostać ukryty ani potraktowany jak zero; `hardBudgetLimit` steruje osobno wyłącznie
odrzuceniem `BUDGET_EXCEEDED`.

### Scoring i diversity

Wagi score są stałą wersjonowaną w kodzie. Każdy komponent i wynik końcowy należy do
zakresu 0–100, a wynik końcowy oblicza kod jako ważoną średnią: `budgetFit` 20%,
`travelTime` 15%, `effectiveTimeAtDestination` 15%, `accommodationLocation` 15%,
`dataCompleteness` 10%, `priceConfidence` 10% i
`deterministicPreferenceFit` 15%. Powody i krótkie objaśnienia wyniku pochodzą z
deterministycznych kodów oraz szablonów, nie z modelu językowego.

Wybór diversity najpierw bierze najwyższy wynik ogólny, a następnie osobno ocenia
wygodę i wartość. Kandydaci o tej samej kombinacji transportu i hotelu nie mogą zostać
wybrani ponownie. Jeżeli istnieją kandydaci z jeszcze niewykorzystanych destynacji,
mają pierwszeństwo przed praktycznie identycznymi wariantami. Przy mniej niż trzech
poprawnych kandydatach silnik zwraca wyłącznie dostępne warianty i jawny niedobór;
nigdy nie poluzowuje constraints.

Wygoda jest liczona jako 40% oceny czasu podróży, 35% efektywnego czasu na miejscu i
25% lokalizacji noclegu. Wartość jest liczona jako 65% dopasowania do budżetu i 35%
pewności ceny. Te wzory, podobnie jak wagi score, należą do wersji kodu i fixture'ów,
a ich zmiana wymaga testu stabilności rankingu.

## Konsekwencje

Cały pipeline można testować bez CAP, przeglądarki, sieci, sekretów i zegara
systemowego. Te same fixture'y i ten sam brief zawsze dają identyczne odrzucenia,
wyniki oraz kolejność. Jawne źródła pozwalają później zastąpić mocki adapterami API bez
zmiany reguł domenowych.

Kosztem jest konieczność utrzymywania wersji fixture'ów, reguł estymacji i scoringu.
Dodanie waluty, zwłaszcza o innej precision, kategorii kosztu, kodu odrzucenia lub komponentu
score wymaga jawnej zmiany kontraktu i testów. Faza 2B nie dodaje endpointu uruchamiającego planowanie,
persystencji kandydatów ani interfejsu ich wyboru.
