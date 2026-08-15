# Zakres MVP

## P0

- europejski city break rozpoczynający się w mieście użytkownika;
- zebranie i potwierdzenie strukturalnego briefu;
- adaptery providerów oddzielone od domeny;
- deterministyczne filtry wykonalności, budżet i scoring;
- trzy zróżnicowane warianty z kompromisami, ryzykami i źródłami;
- szczegółowy plan dopiero po wyborze wariantu.

## Stan realizacji

Faza 2 — od domeny do Planning API and Options UI — jest zakończona. Faza 3B1 dodaje
fundament task-aware execution i trwałego audytu LLM, a Faza 3B2 pierwszy jawny use case
grounded narrative dla wybranej opcji.

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

### Faza 3A — Vendor-neutral LLM Gateway and Secure Credentials

- jeden vendor-neutral kontrakt dla strukturalnych zadań `DECIDE`, `GENERATE`, `JUDGE`
  i `SMOKE`;
- jawny routing OpenAI/Anthropic, per-request override i brak cichego fallbacku;
- oficjalne SDK OpenAI Responses i Anthropic Messages za izolowanymi adapterami;
- structured outputs z obowiązkową, lokalną walidacją Zod;
- bezpieczna konfiguracja, zamknięty katalog błędów, redakcja i telemetria bez payloadów;
- offline testy rzeczywistych requestów SDK oraz osobne, manualne smoke testy live;
- brak zmian UI, CAP, deterministycznego planowania i modelu persistence.

### Faza 3B1 — Task-Aware AI Execution Profiles and Persistent Audit Foundation

- osobne profile provider/model/effort/max output tokens dla `DECIDE`, `GENERATE` i `JUDGE`;
- brak provider override w requestcie produktu i profil przekazywany adapterowi per call;
- osobne `configuredModel` i `responseModel` oraz walidacja metadanych gatewaya;
- stabilny UUID, asynchroniczny recorder i jawna polityka fail-closed;
- wewnętrzne `AiRuns` bez promptów, wejść, wyjść i surowych błędów;
- 30-dniowa domyślna retencja, `expiresAt` i testowalny cleanup bez schedulera;
- pełne testy offline CAP/SQLite; brak akcji CAP lub UI wykonującej AI.

### Faza 3B2 — Grounded Option Narratives

- deterministyczny `grounded-option-context-v1` dla udanego `PlanningRun` i jednej
  `RankedOption`, z budżetem, provenance oraz jawnymi `UNKNOWN`/`MISSING`;
- fail-closed mapowanie source contexts dla transportu/noclegu, jawne wersje wewnętrznych
  derivations oraz kodowo formatowane display values, przy zachowaniu minor units jako źródła;
- zamknięty kontrakt walut `currency-fraction-digits-v1` dla PLN/EUR, pełna zgodność kategorii
  z agregatem budżetu i fail-closed lineage wersji fixture/scoringu;
- unikalne fact IDs związane z wersją i exact context fingerprint;
- wersjonowany prompt `GENERATE` i strict Zod output, w którym każdy blok wymaga niepustych
  referencji rozwiązywanych lokalnie do dokładnego kontekstu;
- addytywna akcja `RankedOptions.generateNarrative()` wykonywana w fazach read → audited AI
  → product write bez aktywnej transakcji podczas provider call;
- dokładna walidacja terminalnego `AiRun` przed persistence, a potem trwały historyczny
  scalar `NarrativeRuns.aiRunId` bez foreign key blokującego 30-dniowy cleanup audytu;
- trwałe `NarrativeRuns`, `OptionNarratives` i `NarrativeFactReferences` powiązane z planem
  i opcją; rekordy potomne dziedziczą linkage audytu przez `NarrativeRuns`;
- brak zmiany rankingu, constraints, budżetu lub opcji po błędzie AI, audytu, walidacji albo
  zapisu produktu;
- domyślny brak live calls przez `AI_ENABLED=false` i pełne testy offline.

## Poza zakresem obecnego MVP

- automatyczne wywołania AI w `startPlanning`, UI narracji i konwersacyjne pytania;
- wykonywanie judge, evale i automatyczne safety checks (Faza 3B3);
- prawdziwi providerzy, live search, kursy walut i aktualna dostępność;
- itinerary dzień po dniu i wybór wariantu;
- rezerwacje, płatności oraz uwierzytelnianie;
- podróże wieloetapowe i międzykontynentalne;
- aplikacje mobilne natywne, współdzielenie planów i automatyczne zmiany ograniczeń.
