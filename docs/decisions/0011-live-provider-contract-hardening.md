# ADR 0011: Utwardzenie kontraktu live providerów przed implementacją adaptera

- Status: zaakceptowane dla offline-only Phase 4B0 Draft PR
- Data: 2026-08-27
- Zakres: GitHub issue #21, wyłącznie Phase 4B0

## Kontekst

Dotychczasowy pipeline planowania korzysta z deterministycznych fixture'ów i wiąże
idempotencję głównie z ich wersją. Taki kontrakt nie opisuje wystarczająco precyzyjnie
pochodzenia live, kompletności ceny, konfiguracji adapterów ani ograniczeń pojedynczego runu.
Bez tych granic przyszły adapter mógłby ukryć brak opłaty obowiązkowej, pomylić brak danych z
zerem, wykonać nieograniczony fan-out albo cicho zwrócić fixture po awarii live.

Phase 4B0 ma utwardzić wyłącznie lokalny, provider-neutral contract. Nie uruchamia sieci, nie
dodaje konfiguracji lub implementacji Duffel i nie zmienia deterministic ranking weights,
selection roles ani hard constraints.

## Decyzja

### SourceSnapshot v2

Każdy nowy fakt providera lub reguły wewnętrznej używa `source-snapshot-v2` i jawnego
`sourceType`: `LIVE`, `FIXTURE` albo `INTERNAL_RULE`. Snapshot utrwala provider i jego
wersję, wersję adaptera, opcjonalną wersję upstream API, opcjonalny fingerprint upstream
schema, fingerprint kanonicznego bezpiecznego query, fingerprint znormalizowanego wyniku,
identyfikator elementu, czas pobrania, opcjonalny czas wygaśnięcia, bezpieczny URL atrybucji,
freshness, walutę oraz — wyłącznie dla fixture — `fixtureVersion`.

Fingerprinty powstają z lokalnych allowlistowanych reprezentacji, nie z raw requestu lub raw
response. Fingerprint wyniku snapshotu jest ponownie wyliczany na granicy silnika z pełnego,
znormalizowanego DTO bez pól raw i musi odpowiadać wartości zadeklarowanej przez adapter.
Fingerprint całego provider call wiąże kolejność tych DTO oraz ich snapshoty, więc zmiana ceny,
daty, odcinka, nazwy, score albo disclosure bez ponownego fingerprintu kończy się fail-closed.
Live URL nie może zawierać credentials, query ani fragmentu. `expiresAt: null`
oznacza brak opublikowanej informacji o wygaśnięciu, a nie domyślną świeżość. Fixture i reguła
wewnętrzna nie mają expiry; live nie może mieć `fixtureVersion`. Powtórzenie tego samego
snapshot ID z inną kanoniczną treścią jest błędem fail-closed.

Historyczny snapshot fixture pozostaje jawnie legacy. Reader może wystawić jego istniejące
pola, ale nie syntetyzuje brakujących wersji lub fingerprintów v2 i nie aktualizuje rekordu.

### OfferPricing v2

Transport i nocleg otrzymują `offer-price-v2`. Istniejące pole `price` zachowuje znaczenie
obowiązkowego subtotalu, a `additionalFees` — obowiązkowych podatków i opłat. Nowe
`mandatoryTotal` jest ceną all-in wymaganą do wyboru; gdy wszystkie trzy wartości są znane,
kod wymaga dokładnie `price + additionalFees = mandatoryTotal` w integer minor units i tej
samej walucie. Nieznana obowiązkowa składowa lub suma nadal blokuje kandydata przez istniejące
reguły kompletności. Model nigdy nie uzupełnia wartości i `UNKNOWN` nigdy nie staje się zerem.

Opłaty warunkowe i opcjonalne ancillary są oddzielnymi kolekcjami o jawnej kompletności
`COMPLETE`, `PARTIAL` albo `UNKNOWN`. Ich znane pozycje zachowują `Money` i źródło, ale są
disclosures: nie są dodawane do siedmiu kategorii budżetu, bufora, score ani hard constraints.
Persistence przechowuje zarówno stan kolekcji (w tym różnicę między `COMPLETE` z zerem pozycji
a `UNKNOWN`), jak i pozycje z `includedInBudget = false`.

Ta zmiana nie zmienia arytmetyki istniejącego budżetu, wag rankingu, tie-breakera ani ról
`BEST_OVERALL`, `MOST_CONVENIENT` i `BEST_VALUE`.

### Provider manifest i planning fingerprint

Każdy nowy run jest związany z kanonicznym `planning-provider-manifest-v1`. Manifest zawiera
dokładnie po jednej roli `TRANSPORT`, `ACCOMMODATION` i `PLACES`, tryb `FIXTURE`/`LIVE`,
bezpieczną tożsamość i wersję providera, adapter ID/version, wersję source contract,
opcjonalną politykę wyszukiwania oraz jawne upstream/fixture lineage. Zawiera także pełną
politykę wykonania. Nie ma miejsca na sekret, header, token, raw payload ani provider base URL.

Kod stabilnie sortuje manifest, serializuje canonical JSON i liczy SHA-256. Nowy
`planning-request-fingerprint-v2` wiąże potwierdzony brief z wersją i fingerprintem manifestu,
kontraktem walut, `offer-price-v2`, wersją engine i scoringu. Manifest JSON, jego wersja i fingerprint są
utrwalane na `PlanningRun`; potomne rekordy otrzymują jego lineage jako obronę przed mieszaniem
wyników różnych konfiguracji.

Instancja adaptera wystawia własny zamknięty `manifestEntry`. Dla trybu `LIVE` jest on
obowiązkowy i musi dokładnie odpowiadać konfiguracji jeszcze przed fan-outem, więc również pusty
wynik nie może ukryć błędnego wiring'u. Kompletne źródła fixture wybranych kandydatów muszą być
związane z fingerprintem faktycznie wykonanego query.

### Ograniczone wykonanie i błędy

`provider-execution-policy-v1` jest run-scoped i ma domyślne, maksymalne wartości:

- timeout 10 000 ms liczony dopiero po uzyskaniu slotu;
- 25 provider calls na run;
- maksymalnie 4 aktywne calls, kolejka FIFO;
- dokładnie 1 attempt na call;
- rate limit `FAIL_FAST`;
- fallback `NONE`.

Jawny override może wyłącznie obniżyć timeout, call budget albo concurrency. Orkiestracja
sprawdza planowany budżet przed fan-outem i rezerwuje każdy call w run-scoped scope. Pierwszy
błąd inny niż cancellation anuluje aktywne i oczekujące sibling calls. Adapter otrzymuje
`AbortSignal`; timeout, cancellation, call-budget boundary i błąd synchroniczny pozostają
kontrolowanymi wynikami wykonania, bez retry i bez ukrytego fallbacku.

Błędy mają zamknięte kategorie: `CANCELLED`, `TIMEOUT`, `RATE_LIMITED`, `UPSTREAM_4XX`,
`UPSTREAM_5XX`, `NETWORK`, `INVALID_SCHEMA`, `PARTIAL_DESTINATION`,
`CALL_BUDGET_EXCEEDED` i `INVALID_EXECUTION_POLICY`. Raw exception, body, response, request,
headers i komunikat upstream nie przechodzą do błędu domenowego, persistence ani logu.
Publiczna granica CAP nadal zwraca provider-neutral `PROVIDER_SEARCH_FAILED`.

Wewnętrzny audit provider calls ma zamknięte statusy i zapisuje wyłącznie sequence, wersję
policy, bezpieczny provider/operation/destination, attempted/attempts/latency, query/result
fingerprints, result count oraz zamkniętą kategorię i status HTTP. Nie przechowuje query,
wyniku, raw błędu, headerów ani sekretów i nie jest projekcją publiczną. Dla rate limitu może
zachować wyłącznie znormalizowane liczby/reset time; `PARTIAL_DESTINATION` zachowuje osobno
zamkniętą kategorię przyczyny. Cały event przechodzi lokalną walidację przed persistence.

### Kompatybilność i zakaz live → fixture fallback

Reader działa w kolejności v2 → zamrożony v1 → exact v0, a writer zapisuje wyłącznie v2.
Algorytmy fingerprintów v1 i v0 oraz ich lineage są odseparowanymi kontraktami historycznymi.
Nowe kolumny legacy pozostają nullable/no-default. Replay nie wykonuje UPDATE, migracji ani
backfillu i nie konstruuje providerów.

Replay sprawdza fail-closed także lineage rekordów potomnych: source snapshots, budget items,
charge collections/disclosures, rejection diagnostics i provider audit. Historyczne v1/v0 nie
mogą zawierać częściowego lineage v2 ani nowych rekordów charge/audit. Legacy snapshot musi
pasować do jednej z zamrożonych konfiguracji fixture/internal-rule i każda opcja musi zachować
źródła. Replay v2 ponownie waliduje pełny snapshot, kolizje source key oraz cały zamknięty event
audytowy, a nie tylko jego wersję manifestu.

Odczyt v1/v0 jest dozwolony tylko dla manifestu identycznego z zamkniętym manifestem obecnych
fixture'ów. Manifest live lub mieszany nigdy nie może odnaleźć historycznego wyniku fixture.
Błąd live kończy wykonanie fail-closed; nie ma silent live → fixture fallback, zmiany
providera ani substytucji wersji.

### Granica przyszłego adaptera i zakres 4B1

Integracja rzeczywistego providera ma pozostać za istniejącymi interfejsami transportu,
noclegów i miejsc. Preferowany jest mały adapter REST-first: transport HTTP, authentication,
pagination, rate-limit metadata i provider-specific schema/mapping pozostają w module adaptera;
do domeny trafia dopiero lokalnie zwalidowany, znormalizowany wynik. Oficjalny SDK wymaga
osobnego uzasadnienia i nie może przenieść typów providera do domeny.

Phase 4B0 nie implementuje `DuffelApiTransportProvider`, nie wykonuje calli Duffel/live i nie
rozpoczyna 4B1. Nie zmienia też obecnej topologii transakcji `startPlanning`, która rozpoczyna
request transaction przed provider fan-outem, chociaż pierwszy zapis następuje dopiero po
wyniku pipeline'u. Docelowe rozdzielenie na krótki read, network bez otwartej transakcji i
krótki write z ponowną walidacją stanu/idempotencji należy do 4B1 i jest poza tym PR.

## Konsekwencje

- Nowy live adapter ma jawny kontrakt provenance, ceny, limitów i bezpiecznego błędu zanim
  powstanie kod integracyjny.
- Fixture pozostaje deterministyczny i zachowuje dotychczasową semantykę rankingu oraz budżetu.
- Historyczne runy pozostają czytelne bez nieudowodnionego lineage i bez zmian w bazie.
- Conditional/optional charges są widoczne, ale nie mogą cicho zmienić ceny użytej przez
  deterministyczny wybór.
- Manifest i audit zwiększają liczbę metadanych persistence, lecz nie zapisują raw danych ani
  sekretów.
- Audyt nie jest publicznym API, a failure przed trwałym `PlanningRun` nie obiecuje trwałego
  rekordu wykonania; ewentualny niezależny durable failure audit wymaga osobnej decyzji.
- Bezpieczne wywołania live nadal wymagają implementacji adaptera, jawnego opt-in i refaktoru
  granicy transakcyjnej w 4B1.

## Rollback

Rollback polega na wycofaniu zmian 4B0 jako jednego zestawu. Wierszy zapisanych z fingerprintem
v2 lub `SourceSnapshot` v2 nie wolno interpretować jako v1/v0 ani przerabiać przez backfill.
Historyczne algorytmy pozostają zamrożone, a żadna ścieżka rollbacku nie może włączyć fallbacku
live → fixture.
