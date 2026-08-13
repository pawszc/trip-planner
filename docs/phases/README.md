# Specyfikacje faz

Pliki w tym katalogu są wersjonowanymi kontraktami implementacyjnymi. Określają dozwolony
zakres pracy, kryteria akceptacji, wymagane testy, politykę kosztów i zdarzenia wymagające
eskalacji. Implementacja nie może cicho wychodzić poza aktywny kontrakt.

## Statusy

| Status        | Znaczenie                                                                 |
| ------------- | ------------------------------------------------------------------------- |
| `PLANNED`     | Kierunek istnieje, ale specyfikacja nie zezwala jeszcze na implementację. |
| `READY`       | Specyfikacja jest zatwierdzona i może zostać przekazana do implementacji. |
| `IN_PROGRESS` | Implementacja trwa na dedykowanym branchu i PR.                           |
| `REVIEW`      | Implementacja znajduje się w pętli review i drobnych poprawek.            |
| `DONE`        | Faza została zmergowana i zweryfikowana na `main`.                        |
| `BLOCKED`     | Dalsza praca wymaga decyzji strategicznej albo usunięcia jawnej blokady.  |

Tylko `READY` zezwala na rozpoczęcie nowej implementacji. `PLANNED` nie przechodzi
automatycznie do `READY`, a zakończenie jednej fazy nie uruchamia kolejnej. Jedna faza albo
task używa jednego brancha i jednego pull requestu.

## Szablon fazy

Każda specyfikacja fazy zawiera wszystkie poniższe sekcje:

```markdown
# Phase <identifier> — <name>

## Goal

## Status

`PLANNED`

## Preconditions

## Scope

## Out of scope

## Architecture constraints

## Acceptance criteria

## Required tests

## Cost/live-call policy

## Escalation triggers

## Definition of Done
```

Brakująca decyzja nie może zostać ukryta w implementacji. Jeżeli wpływa na zakres,
architekturę, kontrakt, bezpieczeństwo, prywatność, koszt albo następne fazy, status należy
zmienić na `BLOCKED` i eskalować problem.
