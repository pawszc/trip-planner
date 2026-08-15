# ADR 0004: Wersjonowane runy planowania i atomowy zapis opcji

- Status: zaakceptowane
- Data: 2026-08-11

## Kontekst

Silnik 2B zwraca kandydatów, odrzucenia, score i maksymalnie trzy role, ale jego wynik nie
był dotąd dostępny z CAP ani trwały. Faza 2C wymaga odtwarzalności, idempotencji,
czytelnych źródeł i braku częściowo zapisanych kart przy błędzie.

## Decyzja

Każdy nowy zapis otrzymuje SHA-256 fingerprint v1 obejmujący potwierdzony brief, profile,
wersję zamkniętego kontraktu walut, fixture providerów, engine i scoringu. Dokładna wersja
kontraktu walut jest również utrwalana na `PlanningRuns`. `PlanningRuns` ma unikalność po
briefie i fingerprincie. Wszystkie trwałe wyniki wskazują `TripRequest`, `WorkflowRun` oraz
`PlanningRun`.

Utrwalamy znormalizowane encje:

- `RankedOptions` — dokładnie trzy finalne karty i komponenty score;
- `BudgetItems` — siedem jawnych kategorii z price type, klasyfikacją oraz osobnymi częściami
  confirmed/estimated, także dla legalnych agregatów mieszanych;
- `SourceSnapshots` — kontrolowane pochodzenie, bez surowych payloadów providerów;
- `OptionNotes` — deterministyczne zalety, kompromisy i ryzyka;
- `RejectionReasons` i `RejectionSummaries` — szczegóły oraz grupowanie kodów;
- `WorkflowTransitions` — audyt kolejności trzech przejść.

Providerzy są wywoływani przed pierwszym zapisem. Udany wynik powstaje w jednej transakcji
requestu. Awaria providera zwraca kontrolowany błąd i nie pozostawia `PlanningRun` ani
wyników. Niedobór trzech opcji jest innym przypadkiem: zapisuje atomowo wersjonowany run i
odrzucenia ze statusem `INSUFFICIENT_OPTIONS`, ale nie zapisuje żadnej finalnej opcji.

Ponowne wywołanie najpierw szuka bieżącego fingerprintu v1. Jeżeli go nie ma, workflow jest
`OPTIONS_READY`, a baza zawiera dokładny fingerprint v0 zapisany przez `main@1b8a852`, reader
może zwrócić ten historyczny run wyłącznie po fail-closed sprawdzeniu: `currencyContractVersion`
pozostaje `null`, status to `SUCCEEDED`, linkage briefu i workflow jest dokładne, lineage
provider/engine/scoring odpowiada zamrożonym wersjom historycznym, `selectedOptionCount` wynosi
3 i istnieją dokładnie trzy tak samo powiązane `RankedOptions`. Replay wykonuje tylko odczyt:
nie aktualizuje rekordu, nie backfilluje lineage i nie wywołuje providerów. Każda niespójność
kończy się `PLANNING_STATE_INCONSISTENT`; fallback v0 nie dotyczy `INSUFFICIENT_OPTIONS`.

Wszystkie nowe zapisy pozostają single-write v1. Potwierdzony brief jest nieedytowalny, więc
nie ma ryzyka, że ten sam fingerprint ukryje zmianę wejścia.

## Konsekwencje

Wynik jest odtwarzalny, publiczne modele nie zależą od schematu providera, a UI może czytać
budżet, źródła i diagnostykę oddzielnie. Kosztem jest większa liczba encji i świadome
duplikowanie wybranych wersji na granicach publicznego kontraktu.

Kontrolowany niedobór wraca jako strukturalny `PlanningRun`, a nie techniczny HTTP 500.
Klient traktuje `status` i `errorCode` jako błąd biznesowy, dzięki czemu ten sam atomowy
commit zachowuje diagnostykę i gwarantuje zero częściowych kart.
