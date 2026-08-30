# Phase 4B1 — Duffel REST transport provider

## Goal

Dostarczyć pierwszy provider-specific adapter rzeczywistych danych podróżnych za istniejącym
seamem `TransportProvider`: `DuffelApiTransportProvider`. Adapter ma lokalnie walidować
zewnętrzny payload, deterministycznie mapować wyłącznie jawne fakty do `TransportOption`,
respektować kontrakty 4B0 oraz przejść pełną weryfikację offline bez requestu do Duffel.

## Status

`DONE — MERGED AND VERIFIED OFFLINE ON MAIN`

Implementacja została zmergowana 2026-08-30 w PR #24 jako
`main@08877d5a733129a6d8f8863e390cc4034abaa2a5`. Finalny head przeszedł lokalne
`npm run verify:full`, `git diff --check` oraz dwa niezależne joby CI `verify`.
GitHub issues #23 i #21 zostały zamknięte jako ukończone.

Faza została jawnie uruchomiona 2026-08-28 z
`main@2a5362c8ffc7f53ca06c40615ca946620e789afb` po merge Phase 4B0 w PR #22.
Tracker: GitHub #23; parent tracker: #21. Branch implementacyjny:
`codex/phase-4b1-duffel-transport-provider`.

Zakończenie fazy potwierdza gotowość adaptera i kontraktów do użycia w testach offline;
nie autoryzuje requestu Duffel, odczytu credentials ani produkcyjnego włączenia. External,
Duffel test/live i paid calls, credential use oraz koszt tej fazy wyniosły odpowiednio
`0`, `0`, `0`, `0` i `USD 0`. Produkcyjny terms/commercial/attribution/persistence gate,
smoke test oraz następny vertical wymagają osobnego kontraktu ze statusem `READY`.

## Preconditions

- Obowiązują `source-snapshot-v2`, `offer-price-v2`, `planning-provider-manifest-v1`,
  `provider-execution-policy-v1`, ADR 0011 i decyzja REST-first Phase 4A.
- Implementacja jest offline-only. Nie istnieje zgoda na Duffel test/live call, odczyt
  credentials, booking, order ani payment.
- Produkcyjne użycie wymaga osobnego potwierdzenia warunków komercyjnych, atrybucji,
  persistence i retencji; nie blokuje to offline test-mode-ready adaptera.

## Scope

### 4B1.0 — bramki wejściowe

- Wprowadzić clock-injected, wersjonowaną politykę świeżości. LIVE offer jest selectable
  tylko, gdy ma poprawne `expiresAt` i `expiresAt > now`. `expiresAt: null` odrzuca ofertę.
  Margines v1 wynosi 0 ms; zmiana wymaga nowej wersji.
- Fixture i `INTERNAL_RULE` zachowują semantykę 4B0 i nie używają zegara live.
- Przebudować `startPlanning` do krótkiego read/checkpointu, provider network bez aktywnej
  transakcji DB oraz krótkiego write z ponownym sprawdzeniem statusu, fingerprintu,
  idempotencji i wyniku równoległego wykonania.
- Zachować single-flight, replay v2 i zamrożone readery v1/v0. Poprawny replay kończy się
  przed konstrukcją providera i network.

### 4B1.1 — granica HTTP

- Użyć platformowego `fetch` przez mały, wstrzykiwany klient. Nowa zależność wymaga
  uzasadnienia.
- Klient przyjmuje allowlistowany endpoint `https://api.duffel.com`, token provider, clock i
  transport. Import, build, standardowy start i testy nie wymagają klucza.
- Każdy fizyczny request przechodzi przez run-scoped `executeUpstream` i respektuje timeout,
  abort, call budget, concurrency oraz audit 4B0.
- Wysyłać `Duffel-Version: v2`, `Accept: application/json`, JSON content type i gzip.
  Authorization nie może pojawić się w błędzie, logu, teście ani persistence.
- Odpowiedź jest dekodowana do `unknown`, walidowana przez Zod i redukowana do jawnej
  allowlisty. Odczyt ma limit 64 MiB po dekompresji, egzekwowany zarówno z bezpiecznego
  `Content-Length`, jak i na strumieniu; limit jest częścią Search Policy identity. Raw
  request/response/error i headers nie są zapisywane.
- 429, timeout, 5xx, invalid JSON/schema, network i cancellation mapują się do zamkniętych
  kategorii bez provider-controlled message lub stack trace.

### 4B1.2 — Search Policy v1

- Adults only z lokalnym limitem 9 pasażerów, economy, return journey z dwiema slices i
  ograniczony fan-out.
- Jeden offer request per destynacja, `return_offers=true`, `view=offers` i jawny
  `supplier_timeout` krótszy od zewnętrznego timeoutu. Każdy request zużywa osobny call.
- Origin nie używa LLM ani geocoding. Wersjonowany, wstrzykiwany katalog mapuje wspierane
  nazwy produktu, np. `Wrocław`, do jawnych kodów IATA. Nieobsługiwany origin kończy się
  przed network. Destination code musi być poprawnym, allowlistowanym kodem IATA.
- Nie wysyłać nieudokumentowanych market/locale/currency params. Oferta przechodzi tylko,
  gdy wszystkie jawne waluty są obsługiwane i zgodne z walutą planowania. Brak FX.
- Brak założenia o checked baggage, self-transfer lub airport change. Niejednoznaczny
  przypadek jest odrzucany, a nie naprawiany.
- Wyniki są lokalnie deduplikowane i stabilnie sortowane przed truncation; upstream order
  nie wpływa na wynik. Liczba ofert w poprawnej odpowiedzi nie ma sztucznego limitu schematu;
  granicą zasobów jest rozmiar odpowiedzi, a dopiero poprawne oferty są redukowane do
  lokalnego limitu wyników.

### 4B1.3 — schemat i mapper

- Kontrakty, Zod schemas i mapper znajdują się poza `srv/domain`, preferencyjnie w
  `srv/providers/duffel/`.
- Walidować offer ID, `expires_at`, `live_mode`, dwie slices i segments, czasy,
  origins/destinations, jawne carrier facts, `base_amount`/currency,
  `tax_amount`/currency, `total_amount`/currency oraz mapowane services.
- Envelope requestu i każda oferta są walidowane osobno. Błędna oferta nie odrzuca poprawnych
  siblings; niepusta odpowiedź bez choć jednej oferty zgodnej ze schematem kończy się
  kontrolowanym `INVALID_SCHEMA`.
- Decimal strings przechodzą do integer minor units bez floating point.
- `price` = jawny base amount, `additionalFees` = jawny tax amount, `mandatoryTotal` = jawny
  total amount. Waluty muszą być identyczne i `base + tax = total`; niespójność odrzuca
  ofertę zamiast wymyślać wartość.
- Jawne available services są optional disclosures i nie są dodawane do mandatory total.
  Endpoint Create Offer Request nie deklaruje ich w odpowiedzi, więc ich brak pozostaje
  `UNKNOWN`; osobna syntetyczna fixture mappera pokrywa przypadek jawnych services.
- Każdy `TransportOption` reprezentuje dwie slices. Duration powstaje z jawnego pola albo z
  jednej udokumentowanej różnicy poprawnych timestampów; connections = segments - 1.
- Source używa stabilnego Duffel offer ID, `source-snapshot-v2`, `expires_at`, bezpiecznej
  atrybucji, wersji API/schema/adaptera, terms policy version i kanonicznych fingerprintów.
  Test mode nadal ma `sourceType: LIVE`; środowisko jest jawne w lineage, a
  `fixtureVersion` pozostaje null.
- Provider manifest i runtime identity są identyczne także dla pustego wyniku.

### 4B1.4 — wiring i dormant smoke

- Dodać jawny profil Duffel bez zmiany candidate engine, ranking weights, diversity roles,
  budget rules ani hard constraints.
- Fixture mode pozostaje osobną konfiguracją; awaria live nie uruchamia fallbacku.
- Dodać integracyjny test `TripPlannerService` i realnej granicy CAP/SQLite bez transakcji
  otwartej podczas kontrolowanego provider wait.
- Można dodać dormant test-mode smoke command, credential-gated, opt-in i wykluczony z
  `verify`/`verify:full`. Nie wolno go wykonać bez osobnej autoryzacji z limitem calli i
  kosztem.

## Out of scope

- Jakikolwiek Duffel request w implementacji, testach, CI lub review.
- Booking, order, payment, repricing do zakupu, cancellation, refund, changes, checkout,
  seats i ancillaries purchase.
- Skyscanner, Kiwi MCP, accommodation, POI, FX i publiczne pola UI dla parametrów Duffel.
- Zmiana scoringu, selection, hard constraints, budżetu lub price confidence.
- Raw payload persistence, provider response cache, token logging, auto-retry i fallback.

## Architecture constraints

- REST-first, konkretny adapter, provider-specific Zod i mapper; brak generic MCP adaptera.
- Domena zna tylko stabilne typy. LLM nie wybiera providera, parametrów, trasy ani ofert.
- Brak faktu oznacza odrzucenie albo jawne `UNKNOWN`; model ani mapper nie zgadują.
- Provider call nie może odbywać się przy aktywnej transakcji DB.
- Każdy request zużywa run-scoped budget; logiczne `search()` nie jest jednostką call.
- Publiczny CAP API nie otrzymuje provider text, raw errors ani credentials.
- Writer pozostaje v2; legacy readery są zamrożone i read-only.
- Produkcyjne włączenie wymaga osobnego terms/commercial gate.

## Acceptance criteria

- Freshness jest clock-injected i odrzuca expired lub missing-expiry LIVE offer przed
  rankingiem i persistence.
- `startPlanning` nie trzyma transakcji DB podczas provider wait i po network ponownie
  waliduje stan/idempotencję.
- Każdy HTTP call przechodzi przez `executeUpstream`, a każdy użyty fakt przez Zod.
- Dwie slices mapują się deterministycznie do outbound/return z poprawnym duration i
  connections.
- Money używa integer minor units; currency i `base + tax = total` są fail-closed.
- IDs, expiry, provenance i fingerprint `SourceSnapshot v2` są stabilne i walidowane.
- Sort, dedup i truncation są niezależne od upstream order.
- Błędy nie ujawniają raw danych ani sekretów.
- Fixture planning, replay, ranking, constraints i E2E zachowują semantykę.
- Standardowa weryfikacja jest offline i credential-free.

## Required tests

- Valid/malformed Duffel fixtures i allowlisted schema projection.
- Policy: wspólne request invariants, limit adults, economy, two slices, wstrzykiwany origin
  mapping związany z manifest/query identity, IATA i fan-out.
- Header/token redaction oraz brak credential access przy import/build/test.
- Slices, segments, duration, connections, IDs i carrier facts.
- Decimal parsing, PLN/EUR, currency mismatch i arithmetic mismatch.
- Expiry przed, na i po granicy oraz null z injected clock.
- Optional services i disclosures bez dodawania do mandatory total.
- Stable sort, dedup, truncation, manifest identity i pusty wynik.
- 429, timeout, 5xx, invalid JSON/schema, network, cancellation i partial destination.
- Wszystkie requesty przez `executeUpstream`; budget/concurrency blokują nadmiar.
- CAP/SQLite read → network → write, revalidation, single-flight i równoległy commit.
- v2/v1/v0 replay bez provider construction/call.
- Injection bez zmiany ranking/hard-constraint logic.
- `npm run verify:full` i `git diff --check`.

## Cost/live-call policy

- External/Duffel/paid calls = 0.
- Credential reads/use oraz `.env` reads/prints/logs = 0.
- `verify`, `verify:full`, CI, import, build i standardowy start są network-free.
- Przyszły smoke wymaga osobnej autoryzacji, limitu calli i raportu kosztu.

## Escalation triggers

Zatrzymaj implementację, jeżeli Duffel v2 nie daje jawnego mandatory total, expiry, dwóch
slices lub provenance; potrzebne są booking/order/payment, publiczne inputy, zmiana money,
rankingu/constraints/budżetu, raw payload persistence, token logging, osłabienie redakcji,
materialna zmiana replay/idempotency, live call albo zakres przestaje mieścić się w jednym
reviewable PR.

## Definition of Done

- Wszystkie criteria i testy są spełnione.
- `npm run verify:full` oraz `git diff --check` przechodzą offline.
- Draft PR raportuje exact source/head SHA, zakres per file, testy, compatibility,
  odstępstwa, ryzyka, call/cost counters i credential use.
- Nie ma ukrytych live/paid calls ani nierozwiązanej eskalacji strategicznej.
