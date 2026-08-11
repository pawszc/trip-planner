# Strategia testów

## Poziomy testów

- Testy jednostkowe uruchamiają czystą walidację domenową i maszynę stanów bez UI i bazy. Obejmują wartości domyślne profili, każdą wagę soft preferences poniżej i powyżej dozwolonego zakresu, granice hard constraints, poprawność godzin, wszystkie dozwolone przejścia, reprezentatywne przejścia niedozwolone oraz brak zmiany stanu po błędzie.
- Testy integracyjne uruchamiają prawdziwy serwer CAP z bazą SQLite in-memory i sprawdzają kontrakt OData. Obejmują utworzenie briefu z domyślnymi i własnymi profilami, odrzucenie niepoprawnych danych, utworzenie `WorkflowRun`, zgodność statusu briefu ze stanem workflow, transakcyjny rollback oraz odrzucenie ponownego potwierdzenia.
- Jeden stabilny test Playwright przechodzi w Chromium dotychczasowy przepływ formularza: zapis szkicu i potwierdzenie constraints. Nowe profile mają wartości domyślne, więc test nie musi wypełniać dodatkowych pól. Przy błędzie Playwright zachowuje screenshot, trace i raport HTML.
- Pull requesty używają danych mockowanych lub lokalnych; nie kontaktują się z płatnymi ani niestabilnymi providerami.
- Przyszłe evale LLM mierzą grounding, zgodność i różnorodność, ale nie zastępują testów kodu.
- Późniejsze smoke testy live API będą osobnym, kontrolowanym workflow z sekretami spoza repozytorium.

## Weryfikacja

`npm run verify` obejmuje lint, typecheck, testy jednostkowe, testy integracyjne i build. `npm run verify:full` uruchamia ten sam zestaw oraz istniejący test E2E. Testów nie wyłącza się ani nie pomija w celu uzyskania zielonego wyniku.
