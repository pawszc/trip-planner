# Strategia testów

## Poziomy testów

- Testy jednostkowe uruchamiają czystą domenę bez UI i bazy. Obejmują wartości domyślne profili, każdą wagę soft preferences poniżej i powyżej dozwolonego zakresu, granice hard constraints, poprawność godzin, wszystkie dozwolone przejścia workflow, reprezentatywne przejścia niedozwolone oraz brak zmiany stanu po błędzie.
- Testy Fazy 2B sprawdzają `Money` i wszystkie `PriceType`, bezpieczne sumowanie minor units, ceny `UNKNOWN`, niezgodne waluty, komplet 13 kodów odrzucenia, wiele powodów dla jednego kandydata, limity buildera, semantyczną deduplikację, komponenty score, dopasowanie preferencji, stabilny tie-breaker, diversity selection i zachowanie przy mniej niż trzech poprawnych wariantach.
- Osobny scenariusz referencyjny uruchamia prawdziwe mock providery dla Wrocławia, dwóch dorosłych i trzech nocy. Test wymaga jawnych odrzuceń, co najmniej trzech poprawnych kandydatów, dokładnie trzech ról wynikowych oraz identycznego rezultatu dwóch niezależnych uruchomień.
- Referencyjne asercje nie są szerokimi snapshotami bez znaczenia biznesowego: wymagają dokładnie 28 zbudowanych kandydatów, 6 poprawnych, 22 odrzuconych oraz kolejności `BEST_OVERALL` Praga, `MOST_CONVENIENT` Wiedeń i `BEST_VALUE` Budapeszt. Osobno sprawdzany jest każdy kod odrzucenia, wzór score, stabilność wejściowej kolejności i niedobór przy dwóch lub zeru poprawnych kandydatach.
- Testy integracyjne uruchamiają prawdziwy serwer CAP z bazą SQLite in-memory i sprawdzają kontrakt OData. Obejmują utworzenie briefu z domyślnymi i własnymi profilami, odrzucenie niepoprawnych danych, utworzenie `WorkflowRun`, zgodność statusu briefu ze stanem workflow, transakcyjny rollback oraz odrzucenie ponownego potwierdzenia.
- Jeden stabilny test Playwright przechodzi w Chromium dotychczasowy przepływ formularza: zapis szkicu i potwierdzenie constraints. Nowe profile mają wartości domyślne, więc test nie musi wypełniać dodatkowych pól. Przy błędzie Playwright zachowuje screenshot, trace i raport HTML.
- Pull requesty używają wersjonowanych fixture providerów; testy Fazy 2B nie odczytują zegara systemowego i nie kontaktują się z płatnymi ani niestabilnymi usługami.
- Przyszłe evale LLM mierzą grounding, zgodność i różnorodność, ale nie zastępują testów kodu.
- Późniejsze smoke testy live API będą osobnym, kontrolowanym workflow z sekretami spoza repozytorium.

## Weryfikacja

`npm run verify` obejmuje lint, typecheck, testy jednostkowe, testy integracyjne i build. `npm run verify:full` uruchamia ten sam zestaw oraz istniejący test E2E. Testów nie wyłącza się ani nie pomija w celu uzyskania zielonego wyniku.
