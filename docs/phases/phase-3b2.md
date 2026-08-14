# Phase 3B2 — Grounded option narratives

## Goal

Dostarczyć pierwszy rzeczywisty use case LLM w produkcie: grounded narratives dla opcji
już wybranych przez deterministyczny pipeline, bez prawa modelu do zmiany faktów,
constraints, budżetu lub rankingu.

## Status

`REVIEW`

Implementacja rozpoczęła się po zmergowaniu bootstrap PR ustanawiającego workflow Level 2
i tę wersjonowaną specyfikację. `REVIEW` oznacza przekazanie kompletnej implementacji do
pętli Draft PR bez automatycznego startu następnej fazy.

## Preconditions

- Faza 3B1 została zmergowana w PR #6.
- Task-aware AI profiles, fail-closed audit i wewnętrzne `AiRuns` pozostają nienaruszone.
- Obowiązuje granica z `docs/ai-workflow.md`: krótki read/commit → AI
  audit/provider/audit bez aktywnej transakcji DB → osobny krótki product write.

## Scope

- Deterministyczny, wersjonowany `GroundedOptionContext` budowany wyłącznie z
  zatwierdzonych `PlanningRun`, `RankedOption` i istniejących provenance/source snapshots.
- Jawne reprezentowanie `UNKNOWN` i missing bez uzupełniania przez LLM.
- Każdy referencjonowalny fakt oraz każda jawna pozycja `UNKNOWN`/missing w
  `GroundedOptionContext` ma deterministyczny, unikalny w tym kontekście `factId`, związany
  z dokładną wersją i fingerprintem kontekstu.
- Wersjonowane prompty dla zadania `GENERATE`.
- Ścisły Zod structured output, w którym każdy generowany blok narracji ma obowiązkową,
  niepustą listę `factReferences` wskazującą `factId` z dokładnego kontekstu użytego w
  requeście.
- Obowiązkowa lokalna walidacja schematu i integralności referencji. Brak pola
  `factReferences`, pusta lista albo identyfikator nieobecny w dokładnym kontekście requestu
  odrzuca cały output przed persistence lub użyciem; błędne referencje nie są cicho usuwane.
- Wewnętrzne persistence wykonania i wyniku narracji jako `NarrativeRuns` i
  `OptionNarratives` albo semantycznie równoważne nazwy zgodne z istniejącym modelem.
- Jawne linkage do właściwych `PlanningRun`, `RankedOption` i dokładnie zwalidowanego
  `AiRun`; po walidacji produkt zachowuje historyczny scalar UUID, a nie association
  blokujące konfigurowalną retencję efemerycznego audytu.
- Jeden jawny CAP use case korzystający z profilu `GENERATE`.
- Kontrolowane zachowanie, w którym błąd albo brak narracji nie zmienia opcji, rankingu,
  hard constraints ani budżetu.
- Dokumentacja i testy.

## Out of scope

- Wykonywanie `JUDGE`, w tym semantyczna ocena, czy tekst rzeczywiście wynika ze wskazanych
  faktów.
- Safety pipeline i wszystkie evale Fazy 3B3.
- Provider albo model fallback.
- Integracje z rzeczywistymi źródłami danych podróżnych.
- Generowanie itinerary.
- Zmiana deterministycznego rankingu, constraints albo budżetu.
- Scheduler cleanup.

## Architecture constraints

- Kod pozostaje jedynym źródłem prawdy dla constraints, kompletności, workflow, rankingu
  i arytmetyki finansowej. LLM tworzy wyłącznie narrację.
- Model nie wykonuje obliczeń finansowych, nie zmienia ugruntowanych wartości i nie
  uzupełnia brakujących danych. Kod przygotowuje human-readable display z minor units i
  precision waluty; model nie dzieli minor units ani nie formatuje pieniędzy. `UNKNOWN` i
  missing pozostają jawne.
- Walidacja 3B2 obejmuje wyłącznie ścisły schemat i deterministyczną integralność
  referencji. Poprawna referencja zapewnia traceability, ale nie dowodzi semantycznie, że
  treść bloku wynika ze wskazanego faktu; taka ocena należy do `JUDGE` w Fazie 3B3.
- Routing odbywa się wyłącznie przez profil `GENERATE`; request produktu nie zmienia
  providera, modelu ani effort i nie istnieje cichy fallback.
- Lifecycle audytu 3B1 pozostaje fail-closed. Durable `STARTED` musi poprzedzać provider
  call, a output może zostać użyty dopiero po lokalnej walidacji i durable `SUCCEEDED`.
- Żadna transakcja DB nie pozostaje aktywna podczas provider call. Product read, wykonanie
  AI z audytem i product write są osobnymi fazami zgodnymi z `docs/ai-workflow.md`.
- `AiRuns` pozostaje wewnętrzne i nie przechowuje promptów, wejść, wyjść ani surowych
  błędów. Jest efemerycznym audytem z niezmienioną konfigurowalną retencją i defaultem 30
  dni; cleanup nie może być blokowany przez trwałe narracje produktu. Nie wolno dodawać
  sekretów ani utrwalać raw provider payloads.
- Prawdziwe dane użytkowników nie mogą zostać wysłane do providera przed zatwierdzeniem
  ustawień retencji organizacji, ZDR i dozwolonego zakresu danych opisanego w
  `docs/ai-gateway.md`.

## Acceptance criteria

- Grounded context jest deterministyczny, wersjonowany i zawiera wyłącznie zatwierdzone
  fakty wraz z provenance oraz jawnymi brakami. Każdy referencjonowalny wpis ma
  deterministyczny, unikalny i związany z dokładnym kontekstem `factId`.
- Wersjonowany request `GENERATE` zwraca wyłącznie wynik zgodny ze ścisłym schematem Zod,
  ponownie zwalidowany lokalnie przed użyciem.
- Każdy blok narracji zawiera co najmniej jeden identyfikator w `factReferences`, a każdy
  identyfikator rozwiązuje się do wpisu w dokładnym `GroundedOptionContext` użytym dla tego
  requestu.
- Brakujące, puste, nieznane, nieaktualne albo pochodzące z innego kontekstu referencje
  powodują odrzucenie całego outputu przed persistence lub użyciem.
- Referencja do istniejącego wpisu jawnie oznaczonego `UNKNOWN`/missing jest poprawna
  referencyjnie i nie może zostać pomylona z nieznanym identyfikatorem.
- Trwały wynik narracji jest jednoznacznie powiązany z planning runem, opcją i właściwym
  audytem AI, a historyczny `aiRunId` pozostaje po dozwolonym cleanup audytu.
- Jawny CAP use case respektuje fazową granicę transakcji i nie odtwarza SQLite deadlocku
  wykrytego w 3B1.
- Awaria AI, walidacji albo audytu nie zmienia deterministycznych opcji, rankingu,
  constraints ani budżetu i nie pozostawia wyniku przedstawianego jako poprawny.
- Dokumentacja opisuje kontrakt, zachowanie przy błędzie i wszystkie znane ograniczenia.
- Nie zostaje zaimplementowany żaden element wymieniony w `Out of scope`.

## Required tests

- Dokładna konstrukcja, wersjonowanie i fingerprint grounded context oraz deterministyczne,
  unikalne generowanie `factId` związanych z tym kontekstem.
- `UNKNOWN` i missing pozostają jawne, otrzymują `factId` i mogą być poprawnym celem
  referencji bez uzupełniania wartości.
- Każdy blok narracji wymaga niepustej listy `factReferences`.
- Brak pola, pusta lista oraz nieznane, nieaktualne lub pochodzące z innego kontekstu
  `factId` odrzucają cały output; walidator nie usuwa błędnych referencji i nie akceptuje
  częściowego wyniku.
- Ścisła walidacja schematu i referential integrity odbywa się lokalnie, bez wykonywania
  `JUDGE`, safety pipeline ani evali.
- Brak provider call przed durable `STARTED`.
- Poprawne linkage planning run/option/AI run.
- Usunięcie wygasłego `AiRun` przez realny CAP/SQLite store nie usuwa ani nie uszkadza
  trwałej narracji i nie pozostawia mandatory database association do audytu.
- Deterministyczne display values pieniędzy, jawne `null` dla `UNKNOWN`/`MISSING` oraz brak
  arytmetyki i formatowania po stronie LLM.
- Rozwiązywalne provenance transportu/noclegu i fail-closed dla dangling lub ambiguous
  source-context mappings.
- `INVALID_GROUNDED_OPTION_CONTEXT` i `INVALID_NARRATIVE_PERSISTENCE` mapowane do HTTP 500.
- Failed AI albo audit nie zmienia deterministycznych opcji.
- Kompozycja transakcji nie odtwarza SQLite deadlocku z 3B1.
- Standardowe testy nie wykonują live ani paid AI.
- Każdy naprawiony błąd otrzymuje test regresyjny.

## Cost/live-call policy

- `npm run verify` i `npm run verify:full` wykonują zero paid/live AI calls.
- Live smoke nie jest uruchamiany automatycznie.
- Jeżeli live call okaże się konieczny do spełnienia acceptance criteria, przed jego
  wykonaniem trzeba eskalować liczbę requestów i przewidywany koszt.

## Escalation triggers

Zatrzymaj implementację i eskaluj, jeżeli:

- grounded context wymaga materialnego redesignu domeny albo modelu danych;
- CAP API wymaga materialnej zmiany kontraktu zamiast addytywnego use case;
- privacy wymaga przechowywania promptów, raw outputs albo raw errors;
- trzeba osłabić fail-closed audit;
- strategicznie zmienia się provider albo model;
- zakres fazy znacząco rośnie.

## Definition of Done

- Wszystkie acceptance criteria są spełnione.
- `npm run verify:full` przechodzi.
- `git diff --check` przechodzi.
- Nie ma ukrytych live ani paid calls.
- Draft PR zawiera kompletny raport wymagany przez szablon repozytorium.
- Nie pozostaje nierozwiązana eskalacja strategiczna.
