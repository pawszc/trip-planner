# Zasady pracy w repozytorium

- Najpierw przeczytaj dokumentację projektu w `docs/`.
- Nie pracuj bezpośrednio na branchu `main`.
- Twarde ograniczenia zawsze waliduje kod.
- LLM nie wykonuje arytmetyki finansowej.
- Brak danych nie może zostać ukryty ani uzupełniony przez model.
- Nie dodawaj sekretów ani plików `.env` do repozytorium.
- Nigdy nie otwieraj, nie wypisuj ani nie loguj zawartości pliku `.env`.
- Live AI wymaga jawnego opt-in; domyślne testy nigdy nie wykonują płatnych requestów.
- Nazwy modeli są jawnie konfigurowane i nigdy nie są cicho zmieniane ani zastępowane.
- Każdy wynik providera AI musi przejść lokalną walidację schematu przed użyciem.
- Routing AI jest kontrolowany wyłącznie przez profile zadań; request produktu nie zmienia providera, modelu ani effort.
- Recorder AI jest asynchroniczny i fail-closed: brak trwałego `STARTED` blokuje request do providera.
- `AiRuns` pozostaje wewnętrzne i nie przechowuje promptów, wejść, wyjść ani surowych błędów.
- Każda zmiana domeny wymaga testów.
- Każdy naprawiony błąd wymaga testu regresyjnego.
- Przed zakończeniem pracy uruchom `npm run verify`.
- Przed pull requestem uruchom `npm run verify:full`.
- Nie pomijaj ani nie wyłączaj testów tylko po to, aby uzyskać zielony wynik.
- Nie commituj `node_modules`, `gen`, `dist`, `coverage`, `test-results` ani `playwright-report`.
- Nie dodawaj zależności bez udokumentowanego uzasadnienia.
- Stosuj małe, czytelne moduły i ścisłe typowanie TypeScript.
- Raportuj wszystkie znane ograniczenia.

## Protokół wykonania Level 2

- Przed implementacją przeczytaj `AGENTS.md`, odpowiednie dokumenty w `docs/` oraz aktywną
  specyfikację w `docs/phases/`.
- Nigdy nie pracuj bezpośrednio na branchu `main`.
- Jedna faza albo task wymaga jednego brancha i jednego pull requestu.
- Zaakceptowana specyfikacja fazy jest kontraktem zakresu i nie wolno jej cicho rozszerzać.
- Drobne błędy i uwagi review w zaakceptowanym zakresie poprawiaj samodzielnie na tym samym
  pull requeście.
- Problem strategiczny eskaluj i zatrzymaj pętlę implementacji do czasu podjęcia decyzji.
- Przy materialnym konflikcie dokumentacji nie zgaduj; opisz konflikt i eskaluj go.
- Przed pull requestem uruchom `npm run verify:full` oraz `git diff --check`.
- W pull requeście raportuj zakres, testy, odstępstwa od specyfikacji, znane
  ograniczenia/ryzyka, external/live calls oraz przewidywany i rzeczywisty koszt płatnych
  API.
