# Workflow development Level 2

## Cel

Level 2 usuwa ręczne przekazywanie wyników między narzędziami. GitHub przechowuje
wersjonowany kontrakt implementacyjny i jest kanałem przekazania pracy, a Notion zachowuje
roadmapę oraz decyzje strategiczne.

## Źródła prawdy i role

- **Notion** — roadmapa, priorytety, statusy wysokiego poziomu i checkpointy wymagające
  decyzji człowieka.
- **GitHub `main` i wersjonowane dokumenty** — źródło prawdy dla aktualnej implementacji,
  architektury i zaakceptowanych specyfikacji.
- **`docs/phases/*.md`** — zatwierdzone kontrakty implementacyjne. Specyfikacja fazy
  wyznacza jej zakres, kryteria akceptacji, testy, politykę kosztów i warunki eskalacji.
- **ChatGPT** — architekt i reviewer produktu. Analizuje repozytorium, diff oraz wyniki
  testów bez kopiowania outputu Codexa.
- **Codex** — wykonawca. Implementuje zaakceptowaną fazę, uruchamia weryfikację i poprawia
  drobne błędy oraz uwagi review na tym samym pull requeście.

W razie materialnego konfliktu między źródłami Codex nie wybiera interpretacji samodzielnie.
Opisuje konflikt, eskaluje go i zatrzymuje implementację do czasu decyzji.

## Kontrakt fazy

Implementację można rozpocząć wyłącznie dla fazy ze statusem `READY`. Status `PLANNED`
oznacza kierunek, a nie zgodę na rozpoczęcie pracy. Zaakceptowanej specyfikacji nie wolno
cicho rozszerzać ani zastępować decyzją podjętą podczas implementacji.

Jedna faza albo task używa jednego dedykowanego brancha i jednego pull requestu. Kolejna
faza nie uruchamia się automatycznie po zakończeniu poprzedniej; musi mieć własny kontrakt
ze statusem `READY`.

## Cykl Level 2

1. Specyfikacja fazy otrzymuje status `READY`.
2. Codex tworzy osobny branch i implementuje wyłącznie zakres tej fazy.
3. Codex wykonuje pełną weryfikację offline wymaganą przez repozytorium i specyfikację.
4. Codex otwiera Draft PR z kompletnym raportem.
5. ChatGPT reviewuje PR, diff, testy i aktualny stan repozytorium bez pośredniego kopiowania
   outputu Codexa.
6. Drobne uwagi wracają do Codexa i są poprawiane na tym samym PR wraz z odpowiednimi
   testami regresyjnymi.
7. Problem strategiczny zatrzymuje pętlę i wymaga decyzji człowieka.
8. Po approval i merge następna faza może ruszyć wyłącznie wtedy, gdy ma status `READY`.

## Autonomiczne poprawki i eskalacja

Codex samodzielnie naprawia błędy, edge cases, lint, typy, nazewnictwo, dokumentację
techniczną, brakujące testy regresyjne i lokalne refaktory, o ile pozostają w zaakceptowanym
zakresie i nie zmieniają kontraktów.

Eskalacja jest wymagana przed materialną zmianą celu lub roadmapy, architektury albo modelu
danych, długoterminowego kontraktu API, zasad security/privacy/retention, providera lub
źródła danych, licencji, kosztów lub live AI, deterministycznych zasad constraints, budżetu
lub rankingu, a także przed znaczącym rozszerzeniem zakresu fazy.

## Pull request i merge

Przed otwarciem PR Codex uruchamia co najmniej `npm run verify:full` i
`git diff --check`. Raport w PR obejmuje specyfikację, zaimplementowany zakres, weryfikację,
odstępstwa, ograniczenia i ryzyka, wszystkie external/live calls, przewidywany i rzeczywisty
koszt płatnych API oraz informację o wymaganej eskalacji.

Level 2 nie zezwala na automatyczny merge. Merge następuje dopiero po zielonym review. Nie
ma również automatycznego startu faz ze statusem `PLANNED`.
