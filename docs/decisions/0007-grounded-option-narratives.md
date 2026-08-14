# ADR 0007: Ugruntowane narracje opcji z referencjami do faktów

- Status: zaakceptowane
- Data: 2026-08-13

## Kontekst

Po Fazie 3B1 produkt ma task-aware gateway i trwały audyt, ale nie wykonuje jeszcze AI.
Pierwszy use case musi opisać wariant wybrany wcześniej przez deterministyczny pipeline bez
zmiany faktów, constraints, budżetu ani rankingu. Sam structured output nie wystarcza:
każdy blok tekstu musi wskazać dokładne fakty z dokładnego kontekstu requestu, a brakujące
dane muszą pozostać widoczne.

SQLite ma domyślnie jedno połączenie. Uruchomienie persistent gatewaya wewnątrz aktywnej
transakcji requestu prowadziłoby do circular wait opisanego w ADR 0006. Produktowy use case
musi więc zachować granicę odczyt → AI z niezależnym audytem → osobny zapis produktu.

## Decyzja

### GroundedOptionContext i factId

Akcja pracuje wyłącznie na `PlanningRun` ze statusem `SUCCEEDED` i jednej powiązanej
`RankedOption`. Krótka transakcja odczytu pobiera także jej `BudgetItems` oraz istniejące
`SourceSnapshots`, po czym kończy się przed wywołaniem gatewaya. Kontekst nie pobiera
swobodnego tekstu użytkownika ani nie pozwala modelowi zmienić opcji.

`GroundedOptionContext` ma jawną wersję `grounded-option-context-v1`. Fakty opcji,
budżetu i provenance są stabilnie sortowane, a canonical JSON bez `factId` otrzymuje
SHA-256 `contextFingerprint`. Dopiero wtedy każdy fakt dostaje identyfikator
`fact_<sha256(version + contextFingerprint + factKey)>`. Klucze faktów są unikalne w
kontekście, więc identyfikatory są deterministyczne, unikalne i związane z dokładną wersją
oraz fingerprintem.

Każda z siedmiu kategorii budżetu występuje jako osobny fakt. Brak rekordu otrzymuje status
`MISSING`, a rekord z klasyfikacją `UNKNOWN` status `UNKNOWN`; oba zachowują `null` zamiast
wymyślonej wartości i oba otrzymują normalny `factId`. Istniejące źródła są osobnymi
faktami provenance, a dangling source reference odrzuca cały kontekst.

Transport i nocleg wskazują dokładnie jeden istniejący `SourceSnapshot` wyznaczony przez
persisted contexts `TRANSPORT_FACT` i `ACCOMMODATION_FACT`. Brak mapowania, więcej niż jedno
mapowanie albo kontekst budżetowy niezgodny z `BudgetItems.sourceSnapshot` odrzuca cały
kontekst. Fakty powstałe w kodzie, w tym selection, score i agregat budżetu, nie podszywają
się pod źródło zewnętrzne: mają jawny marker `INTERNAL_DETERMINISTIC` i odpowiednią wersję
silnika, scoringu lub formatowania.

Minor units pozostają finansowym źródłem prawdy. Kod `grounded-money-display-v1` ustala
precision waluty i bez floating point tworzy jawne wartości display dla limitu, sumy,
kwot confirmed/estimated, kosztu na osobę i pozostałego budżetu. Kategorie budżetu również
mają kodowo przygotowane display albo `null`. Model używa tych tekstów verbatim; nie dzieli
minor units, nie ustala precision i nie formatuje pieniędzy.

### Prompt i output

Use case zawsze wybiera profil `GENERATE`. Request nie ma provider/model/effort override.
Prompt `grounded-option-narrative-prompt-v1` zabrania obliczeń, dzielenia minor units,
ustalania precision waluty, formatowania pieniędzy, zmiany wartości i uzupełniania
`UNKNOWN`/`MISSING`. Schemat `grounded-option-narrative-schema-v1` jest strict i wymaga:

- dokładnego `contextFingerprint`;
- od jednego do ośmiu bloków `SUMMARY`, `ADVANTAGE`, `TRADEOFF` lub `RISK`;
- niepustego tekstu;
- co najmniej jednego, niepowtórzonego `factId` w `factReferences` każdego bloku.

Ten sam lokalny schemat jest przekazywany helperom structured output obu SDK. Walidacja
referencyjna odrzuca identyfikator nieobecny w dokładnym kontekście, w tym identyfikator
nieaktualny lub pochodzący z innej opcji. Nie usuwa błędnego bloku ani referencji. Wynik
jest ponownie walidowany bezpośrednio przed persistence.

Poprawna referencja zapewnia traceability, ale nie dowodzi semantycznie, że tekst wynika z
faktu. Taka ocena, safety pipeline i wykonywanie `JUDGE` pozostają w Fazie 3B3.

### CAP, persistence i transakcje

`RankedOptions.generateNarrative()` jest addytywną bound action. Wykonuje trzy fazy:

1. osobna krótka transakcja odczytu buduje i zatwierdza kontekst;
2. persistent gateway utrwala `STARTED`, wykonuje profil `GENERATE` bez aktywnej transakcji
   produktu i utrwala `SUCCEEDED` albo `FAILED`;
3. dopiero po terminalnym `SUCCEEDED` osobna transakcja requestu atomowo zapisuje wynik.

Przed pierwszym zapisem produktu writer ponownie odczytuje wskazany `AiRun` i wymaga
terminalnego `SUCCEEDED` oraz dokładnej zgodności `PlanningRun`, tasku `GENERATE`, wersji
promptu, wersji schematu i input fingerprint. Dopiero po tej walidacji `NarrativeRuns`
utrwala niezmienny historyczny `aiRunId` jako scalar UUID wraz z bezpiecznymi wersjami i
fingerprintem kontekstu. Nie ma foreign key ani mandatory association z produktu do
`AiRuns`.

`OptionNarratives` przechowuje zwalidowane bloki, a `NarrativeFactReferences` normalizuje
kolejność i dokładne `factId`; oba dziedziczą linkage audytu przez `NarrativeRuns` i nie
duplikują `AiRun`. `AiRuns` jest efemerycznym wewnętrznym audytem z konfigurowalną retencją
i defaultem 30 dni. `NarrativeRuns`, bloki i referencje są danymi produktu i przeżywają
`deleteExpired(now)`. Żadna z tych encji nadal nie przechowuje promptu, grounded input,
raw output, raw error ani credentiali, a publiczny serwis nie publikuje encji `AiRuns`.

Awaria konfiguracji, providera, schematu, referencji, audytu albo product write nie zmienia
`RankedOptions`, rankingu, constraints ani budżetu. Rollback późniejszego zapisu narracji
nie usuwa wcześniej zatwierdzonego audytu AI.

### Opt-in, prywatność i koszt

`AI_ENABLED=false` pozostaje defaultem i blokuje akcję przed utworzeniem `AiRun` oraz call
providera. Operator może ustawić `AI_ENABLED=true` dla tego use case'u dopiero po
zatwierdzeniu retencji organizacji providera, dostępności/zakresu ZDR, polityki prywatności
i dozwolonego zakresu danych. Samo `store: false` nie zastępuje tej decyzji operacyjnej.
Standardowe testy używają wyłącznie adaptera offline i nie wykonują live ani paid calls.

## Konsekwencje

Pierwszy produktowy tekst AI ma odtwarzalny kontekst, dokładne linkage i lokalnie
sprawdzalne referencje. Jawne braki nie mogą zostać cicho usunięte przez mapper ani
validator. Rozdzielenie transakcji zapobiega deadlockowi SQLite i zachowuje fail-closed
audyt.

Rozdzielenie lifecycle pozwala usuwać przeterminowane `AiRuns` bez kasowania produktu i bez
dangling mandatory associations. Historyczny UUID nie jest po cleanup rozwiązywalnym
foreign key, ale nadal jednoznacznie identyfikuje audyt, który został sprawdzony przed
persistence.

Kosztem jest większy model persistence, osobne identyfikatory faktów i brak semantycznej
gwarancji bez `JUDGE`. Akcja generuje narrację pojedynczej opcji na żądanie; nie jest
automatycznie wywoływana przez `startPlanning` ani UI. Nie ma fallbacku providera/modelu,
schedulera cleanup, bieżących źródeł podróżnych ani automatycznych evali.
