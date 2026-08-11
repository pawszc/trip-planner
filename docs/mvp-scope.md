# Zakres MVP

## P0

- europejski city break rozpoczynający się w mieście użytkownika;
- zebranie i potwierdzenie strukturalnego briefu;
- adaptery providerów oddzielone od domeny;
- deterministyczne filtry wykonalności, budżet i scoring;
- trzy zróżnicowane warianty z kompromisami, ryzykami i źródłami;
- szczegółowy plan dopiero po wyborze wariantu.

## Stan realizacji

Faza 2 — od domeny do Planning API and Options UI — jest zakończona.

### Faza 2A — Domain and Workflow Core

- jawne profile hard constraints i soft preferences;
- walidacja briefu i profili w kodzie;
- osobny `WorkflowRun` i domenowa maszyna stanów;
- transakcyjne `confirmConstraints`.

### Faza 2B — Mock Providers and Deterministic Candidate Engine

- typowane kontrakty transportu, noclegów i miejsc;
- wersjonowane fixture providery bez internetu i zegara systemowego;
- `Money` w minor units, budżet, pełny katalog odrzuceń i `SourceSnapshot`;
- wersjonowany scoring i deterministyczny wybór trzech ról.

### Faza 2C — Planning API and Options UI

- bound action `TripRequests.startPlanning`;
- trwałe, wersjonowane `PlanningRuns`, trzy `RankedOptions`, `BudgetItems`,
  `SourceSnapshots`, `OptionNotes`, `RejectionReasons` i ich podsumowania;
- atomowe przejścia `CONSTRAINTS_CONFIRMED` → `SEARCHING` →
  `CANDIDATES_VALIDATED` → `OPTIONS_READY` z audytem kolejności;
- idempotentne ponowne wywołanie bez duplikatów;
- kontrolowany niedobór bez poluzowania constraints i bez częściowych kart;
- responsywny, dostępny formularz oraz dokładnie trzy pełne karty wariantów;
- pełny scenariusz Playwright, obejmujący źródła, budżet i odrzucenia.

### Faza 2D — Hardening

- jedna ścisła walidacja istniejących dat ISO na wszystkich granicach zapisu i planowania;
- koaleskowanie równoległych `startPlanning` bez podwójnego pipeline'u i duplikatów;
- edycja zapisanego `DRAFT` oraz nowy brief z obecnych danych po niedoborze opcji;
- jawne oznaczenie w UI, że fixture Fazy 2 jest demonstracyjnym scenariuszem z Wrocławia;
- drugi scenariusz Playwright dla `INSUFFICIENT_OPTIONS`, zerowych kart i nowego briefu.

## Poza zakresem obecnego MVP

- LLM, prompty produkcyjne i konwersacyjne pytania;
- prawdziwi providerzy, live search, kursy walut i aktualna dostępność;
- itinerary dzień po dniu i wybór wariantu;
- rezerwacje, płatności oraz uwierzytelnianie;
- podróże wieloetapowe i międzykontynentalne;
- aplikacje mobilne natywne, współdzielenie planów i automatyczne zmiany ograniczeń.
