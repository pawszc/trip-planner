# Workflow development Level 2

## Cel

Level 2 usuwa ręczne kopiowanie wyników w kierunku Codex → ChatGPT: GitHub jest kanałem
przekazania pracy, a ChatGPT czyta PR, diff, testy i wersjonowane dokumenty bez kopiowania
outputu Codexa. Kierunek ChatGPT → Codex nie jest jeszcze automatyczny; do Level 2.5/3
przekazanie uwag review wymaga jawnego, uruchomionego przez użytkownika handoffu. Notion
zachowuje roadmapę oraz decyzje strategiczne.

## Źródła prawdy i role

- **Notion** — roadmapa, priorytety, statusy wysokiego poziomu i checkpointy wymagające
  decyzji człowieka.
- **GitHub `main` i wersjonowane dokumenty** — źródło prawdy dla aktualnej implementacji,
  architektury i zaakceptowanych specyfikacji.
- **`docs/phases/*.md`** — zatwierdzone kontrakty implementacyjne. Specyfikacja fazy
  wyznacza jej zakres, kryteria akceptacji, testy, politykę kosztów i warunki eskalacji.
- **ChatGPT** — architekt i reviewer produktu. Analizuje repozytorium, diff oraz wyniki
  testów bez kopiowania outputu Codexa.
- **Codex** — wykonawca. Implementuje zaakceptowaną fazę, uruchamia weryfikację i po jawnym
  handoffie użytkownika poprawia drobne błędy oraz uwagi review na tym samym pull requeście.

W razie materialnego konfliktu między źródłami Codex nie wybiera interpretacji samodzielnie.
Opisuje konflikt, eskaluje go i zatrzymuje implementację do czasu decyzji.

## Kontrakt fazy

Implementację można rozpocząć wyłącznie dla fazy ze statusem `READY`. Status `PLANNED`
oznacza kierunek, a nie zgodę na rozpoczęcie pracy. Zaakceptowanej specyfikacji nie wolno
cicho rozszerzać ani zastępować decyzją podjętą podczas implementacji.

Po rozpoczęciu pracy status przechodzi przez `IN_PROGRESS` do `REVIEW`. `REVIEW` oznacza
Draft PR i pętlę weryfikacji, a nie spełnienie Definition of Done. Jeżeli kontrakt wymaga
osobno zatwierdzonego live baseline, brak zgody lub niewykonany baseline utrzymuje fazę w
`REVIEW`; nie wolno zastąpić dowodu offline wynikiem domniemanym ani cicho oznaczyć fazy
jako `DONE`.

Jedna faza albo task używa jednego dedykowanego brancha i jednego pull requestu. Kolejna
faza nie uruchamia się automatycznie po zakończeniu poprzedniej; musi mieć własny kontrakt
ze statusem `READY`.

## Cykl Level 2

1. Specyfikacja fazy otrzymuje status `READY`.
2. Codex tworzy osobny branch i implementuje wyłącznie zakres tej fazy.
3. Codex wykonuje pełną weryfikację offline wymaganą przez repozytorium i specyfikację.
4. Codex otwiera Draft PR z kompletnym raportem.
5. ChatGPT reviewuje przez GitHub PR, diff, testy i aktualny stan repozytorium bez
   pośredniego kopiowania outputu Codexa.
6. Użytkownik jawnie uruchamia handoff uwag review z ChatGPT do Codexa; Level 2 nie wykonuje
   tego kroku automatycznie.
7. Po tym handoffie Codex poprawia drobne uwagi na tym samym PR wraz z odpowiednimi testami
   regresyjnymi.
8. Problem strategiczny zatrzymuje pętlę i wymaga decyzji człowieka.
9. Wymagany live baseline może zostać uruchomiony tylko po osobnej zgodzie obejmującej
   dokładny plan wywołań i konserwatywny koszt; wynik i rzeczywisty koszt trafiają do PR.
10. Po approval, spełnieniu wszystkich bramek i merge następna faza może ruszyć wyłącznie
    wtedy, gdy ma status `READY`.

Każda kolejna iteracja ChatGPT → Codex również wymaga jawnego handoffu uruchomionego przez
użytkownika. Automatyczne przekazywanie feedbacku w tym kierunku pozostaje poza Level 2 i
może zostać wprowadzone dopiero w Level 2.5/3.

## Autonomiczne poprawki i eskalacja

Po rozpoczęciu pracy albo jawnym handoffie użytkownika Codex samodzielnie naprawia błędy,
edge cases, lint, typy, nazewnictwo, dokumentację techniczną, brakujące testy regresyjne i
lokalne refaktory, o ile pozostają w zaakceptowanym zakresie i nie zmieniają kontraktów.

Eskalacja jest wymagana przed materialną zmianą celu lub roadmapy, architektury albo modelu
danych, długoterminowego kontraktu API, zasad security/privacy/retention, providera lub
źródła danych, licencji, kosztów lub live AI, deterministycznych zasad constraints, budżetu
lub rankingu, a także przed znaczącym rozszerzeniem zakresu fazy.

## Pull request i merge

Przed otwarciem PR Codex uruchamia co najmniej `npm run verify:full` i
`git diff --check`. Raport w PR obejmuje specyfikację, zaimplementowany zakres, weryfikację,
odstępstwa, ograniczenia i ryzyka, wszystkie external/live calls, przewidywany i rzeczywisty
koszt płatnych API oraz informację o wymaganej eskalacji.

Level 2 nie zezwala na automatyczny merge. Merge następuje dopiero po zielonym review i
spełnieniu wszystkich wymaganych bramek, w tym osobno zatwierdzonego baseline, jeśli
przewiduje go kontrakt fazy. Nie ma również automatycznego startu faz ze statusem
`PLANNED`.
