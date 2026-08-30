# Phase 4B2 — Duffel activation readiness and bounded test-mode smoke

## Goal

Przygotować audytowalną, credential-free bramkę aktywacyjną dla adaptera Duffel z Phase 4B1
oraz dormant runner dla jednego przyszłego requestu w Duffel test mode. Faza ma najpierw
udowodnić offline, że scenariusz, limity, warunki użycia, bezpieczne evidence i ścieżka błędu
są zamknięte. Nie zezwala na wykonanie requestu do Duffel.

## Status

`DONE — OFFLINE READINESS MERGED / TEST-MODE REQUEST NOT AUTHORIZED`

Kierunek i kolejność zostały zaakceptowane 2026-08-30. Implementacja offline, review i
wymagane testy są zmergowane i zweryfikowane na `main`. Uruchomienie smoke pozostaje osobną
decyzją wymagającą nowego planu związanego z aktualnym SHA oraz jawnej zgody.

## Preconditions

- Implementacja Phase 4B1 z PR #24 i jej closeout PR #25 są zmergowane; Phase 4B1 ma status
  `DONE` na `main@942853f4d0f6779f2f7320daa967948bacb053ce`.
- Kontrakt 4B2 został zmergowany w PR #26 do
  `main@4517dc8260b11be68cd52ac710008b0eb4004264`; branch implementacyjny powstał dokładnie z
  tego SHA.
- Obowiązują ADR 0011, `source-snapshot-v2`, `offer-price-v2`,
  `planning-provider-manifest-v1`, `provider-execution-policy-v1`, Duffel Search Policy v1
  oraz fail-closed mapper Phase 4B1.
- Nie istnieje zgoda na odczyt tokenu, pliku `.env`, request sieciowy, booking, order, payment
  ani produkcyjne włączenie Duffel.

## Scope

### 4B2.0 — wersjonowana decyzja aktywacyjna

- Dodać ADR/checklistę opartą wyłącznie na oficjalnych źródłach Duffel. Każdy fakt zewnętrzny
  ma link i datę odczytu; decyzja projektu jest oznaczona osobno od faktu dostawcy.
- Udokumentować test mode, activation path, publiczne składniki cenowe, fair-use/search-ratio,
  wymagania dotyczące prezentacji warunków oferty i przewoźnika oraz znane ograniczenia
  persistence/retencji. Dokument jest bramką techniczno-operacyjną, a nie opinią prawną.
- Dla niejednoznacznego obowiązku zapisać właściciela i stan `UNRESOLVED`; nie uzupełniać
  znaczenia przez interpretację modelu. `UNRESOLVED` blokuje production activation, ale nie
  musi blokować credential-free implementacji ani jednoznacznie dozwolonego test-mode smoke.
- Rozdzielić trzy decyzje: gotowość offline, osobna zgoda na dokładnie jeden test-mode smoke
  oraz przyszła production activation. Żadna z nich nie implikuje kolejnej.

### 4B2.1 — credential-free preflight

- Dodać `duffel:smoke:preflight`, który nie ładuje `.env`, nie odczytuje credentials i nie
  wykonuje sieci. Polecenie ma działać w standardowym środowisku developerskim i CI.
- Preflight waliduje dokładny source SHA, czyste albo jawnie opisane drzewo, wersje
  adaptera/API/schema/policy/manifestu, środowisko `TEST`, scenariusz, daty, liczbę pasażerów,
  klasę, origin/destination, plan requestów, timeouty i wszystkie limity.
- Wynikiem jest kanoniczny, bezpieczny plan i jego SHA-256 fingerprint. Plan nie zawiera
  tokenu, nagłówków, raw requestu, raw response, danych providera ani provider-controlled text.
- Plan dopuszcza dokładnie jeden logiczny `search()` dla jednej destynacji i dokładnie jeden
  fizyczny Create Offer Request: `maxCalls=1`, `maxConcurrency=1`, `maxAttempts=1`, retry 0,
  fallback `NONE`, bez pagination, polling, offer refresh, order i payment.
- Preferowany scenariusz produktu to `WRO → PRG → WRO`, 1 dorosły, economy. Konkretne daty
  muszą być przyszłe i zamrożone w planie przed prośbą o zgodę. Nie wolno cicho zastąpić trasy
  produkcyjnej trasą test-only w celu uzyskania zielonego wyniku.
- Preflight raportuje górny limit requestów, credential reads i kosztu. Dla tej fazy wykonanie
  ma zawsze `request count = 0`, `credential use = 0`, `actual external cost = 0`.

### 4B2.2 — dormant test-mode runner

- Dodać jawny command `duffel:smoke:test`, wykluczony z `verify`, `verify:full`, standardowego
  startu, CI oraz import/build. Samo istnienie commandu nie jest zgodą na jego uruchomienie.
- Runner wymaga równocześnie dokładnego fingerprintu zatwierdzonego planu, jawnego opt-in oraz
  tokenu o test-mode identity. Brak któregokolwiek warunku kończy się przed credential access
  albo — gdy sprawdzana jest tożsamość tokenu — przed network.
- Akceptowany jest wyłącznie jawny token testowy Duffel. Token live albo token o nieznanej
  tożsamości jest odrzucany przed network i nigdy nie pojawia się w wyjściu, błędzie, logu,
  evidence lub persistence.
- Runner używa istniejących `DuffelApiTransportProvider`, `ProviderHttpClient` i
  `ProviderExecutionScope`; nie tworzy równoległej, słabiej walidowanej ścieżki HTTP.
- Runner nie uruchamia `TripPlannerService`, nie wykonuje zapisu produktu/SQLite i nie tworzy
  `PlanningRun`. Sprawdza wyłącznie zewnętrzną granicę transportu i lokalne mapowanie dla
  zatwierdzonego query.
- Każdy stan terminalny kończy proces po pierwszej próbie. 429, timeout, 4xx/5xx, network,
  invalid JSON/schema, `live_mode=true`, pusty wynik albo brak poprawnie zmapowanej oferty nie
  uruchamiają retry, fallbacku ani drugiej trasy.

### 4B2.3 — bezpieczne evidence i wynik smoke

- Evidence przechodzi lokalny, zamknięty schemat i może zawierać wyłącznie: source SHA,
  plan/query fingerprint, wersje kontraktów, `TEST`, rozpoczęcie/zakończenie, latency,
  request/attempt count, zamknięty status, bezpieczny HTTP status, result count,
  result fingerprint i zamkniętą kategorię błędu.
- Evidence nie przechowuje raw planu podróży, raw request/response, ofert, cen, identyfikatorów
  ofert, nazw przewoźników, nagłówków, tokenu, ścieżki credential source, provider text,
  exception message ani stack trace.
- `PASS` wymaga dokładnie jednego requestu i jednej próby, odpowiedzi zgodnej ze schematem,
  `live_mode=false` oraz co najmniej jednej oferty poprawnie zmapowanej przez kontrakt 4B1.
  Sam HTTP 2xx lub poprawna pusta odpowiedź nie wystarczają.
- `NO_USABLE_OFFER` jest kontrolowanym wynikiem negatywnym. Jeżeli produktowa trasa nie daje
  użytecznego evidence w sandboxie, zatrzymać się i eskalować; nie wykonywać automatycznie
  kolejnego requestu.
- Raport po przyszłym smoke musi podać planowany i rzeczywisty request/attempt count,
  credential use, środowisko, koszt oraz bezpieczny wynik. Raport nie może ujawnić sekretu ani
  danych odrzuconych przez allowlistę.

### 4B2.4 — osobna zgoda na przyszły smoke

- Prośba o wykonanie smoke wskazuje exact commit SHA, plan fingerprint, dokładną trasę i daty,
  `TEST`, 1 pasażera, economy, limit 1 requestu/1 próby, retry 0, fallback `NONE`, timeout,
  credential channel oraz szacowany maksymalny koszt.
- Zgoda jest jednorazowa i dotyczy wyłącznie wskazanego planu. Zmiana SHA, fingerprintu,
  trasy, daty, limitu, środowiska albo credential channel unieważnia zgodę.
- Po zgodzie wykonać ponownie preflight na tym samym SHA. Jakakolwiek rozbieżność zatrzymuje
  smoke przed credential access i network.
- Ten kontrakt, jego implementacja, review ani zielone CI nie stanowią zgody na request.

## Out of scope

- Wykonanie jakiegokolwiek Duffel requestu w tej fazie implementacyjnej, review, testach lub
  CI bez późniejszej, osobnej zgody opisanej w 4B2.4.
- Duffel live mode, produkcyjny token, realna rezerwacja, order, payment, repricing do zakupu,
  cancellation, refund, changes, checkout, seats i ancillary purchase.
- Automatyczne przejście z test mode do live, włączenie providera dla użytkowników lub zmiana
  domyślnej konfiguracji aplikacji.
- Test-only routes spoza katalogu produktu, rozszerzenie origin/destination catalog, zmiana
  Search Policy v1, rankingu, selection, budgetu, hard constraints lub freshness.
- Raw payload persistence, provider cache, zapisy produktu, publiczne pola UI i telemetry
  zawierające dane providera.
- Negocjowanie umowy, interpretacja prawna albo obietnica przyszłej ceny na podstawie strony
  publicznej.

## Architecture constraints

- Preflight jest deterministyczny, credential-free i network-free. Standardowe testy używają
  wyłącznie injected/mock transportu.
- Twarde limity waliduje kod. Prompt, LLM, dokumentacja ani operator nie są jedyną bramką
  request count, environment, token identity, retry lub fallback.
- Runner nie omija schema validation, mappera, redakcji, `executeUpstream`, call budgetu,
  timeoutu ani audytu Phase 4B1.
- Brak danych pozostaje brakiem danych. Pustego wyniku, nieznanej waluty, ceny, expiry,
  carrier facts lub warunków nie wolno syntetyzować.
- LLM nie wybiera trasy, parametrów, providera, oferty ani statusu smoke i nie wykonuje
  arytmetyki kosztów. Wszystkie liczniki i wartości kosztowe liczy deterministyczny kod.
- Import, build, `verify`, `verify:full`, CI i zwykły start nie odczytują credentiali i nie
  wykonują requestów Duffel.

## Acceptance criteria

- ADR/checklista jasno oddziela oficjalne fakty Duffel, decyzje projektu i nierozstrzygnięte
  obowiązki; production activation ma własną zamkniętą bramkę.
- Credential-free preflight generuje stabilny fingerprint identycznego planu i fail-closed
  odrzuca każdą niedozwoloną zmianę.
- Dormant runner nie jest osiągalny ze standardowych skryptów i wymaga exact plan approval,
  opt-in oraz test-mode token identity.
- Kod gwarantuje co najwyżej jeden request i jedną próbę, bez retry, fallbacku i ukrytego
  fan-outu.
- Sukces dowodzi przejścia realnego test-mode payloadu przez schemat i mapper 4B1 oraz obecności
  co najmniej jednej użytecznej oferty; nie utożsamia HTTP 2xx z sukcesem integracji.
- Wszystkie failure modes są bezpieczne, zamknięte i nie ujawniają raw danych ani sekretów.
- Evidence jest schema-validated, allowlisted i zawiera planowane oraz rzeczywiste liczniki.
- Pełna weryfikacja fazy przechodzi bez tokenu, `.env`, sieci i płatnego requestu.

## Required tests

- Preflight nie ładuje credentiali ani transportu sieciowego i jest deterministyczny dla
  tego samego planu/source SHA.
- Zmiana SHA, scenariusza, daty, limitu, wersji adaptera/policy albo planu zmienia fingerprint
  i unieważnia approval binding.
- Brak opt-in kończy się przed credential access i network.
- Brak tokenu, token live i token o nieznanej tożsamości kończą się przed network; sekret nie
  pojawia się w stdout/stderr, błędzie ani evidence.
- Mock transport potwierdza dokładnie 1 logiczny search, 1 fizyczny request, 1 attempt,
  `maxConcurrency=1`, retry 0 i fallback `NONE`.
- Poprawny test-mode fixture z co najmniej jedną ofertą daje `PASS`; `live_mode=true`, pusty
  wynik, brak użytecznej oferty, malformed JSON/schema, 429, 4xx/5xx, timeout i network dają
  bezpieczny wynik negatywny bez ponowienia.
- Runner używa produkcyjnego klienta, scope, schema i mappera 4B1 z injected transportem;
  test nie dubluje algorytmu mapowania.
- Evidence allowlista odrzuca token, headers, raw request/response, offer IDs, ceny, carrier
  facts, provider text, exception message i stack trace.
- `npm run verify:full` i `git diff --check` przechodzą offline, a dormant smoke command nie
  jest wywoływany przez żaden z tych skryptów.

## Cost/live-call policy

- W implementacji 4B2: external/Duffel/paid calls = 0, credential reads/use = 0,
  `.env` reads/prints/logs = 0, rzeczywisty koszt = 0.
- Przyszły, osobno zatwierdzony smoke: środowisko `TEST`, dokładnie 1 fizyczny Offer Request,
  maksymalnie 1 attempt, retry 0, fallback `NONE`. Na podstawie oficjalnego opisu test mode
  oczekiwany API spend wynosi 0 USD; raport podaje to jako estymację dla testu, nie gwarancję
  warunków produkcyjnych.
- Publiczne ceny live są informacją wejściową do późniejszej bramki production activation.
  Dashboard/order form i obowiązująca umowa są źródłem rozstrzygającym przed live; projekt nie
  utrwala publicznej ceny jako gwarantowanego cennika.
- Jakikolwiek dodatkowy request, ponowienie, test innej trasy albo użycie live tokenu wymaga
  nowej decyzji i pozostaje poza 4B2.

## Official Duffel references

Źródła odczytane 2026-08-30:

- [Test mode](https://duffel.com/docs/api/overview/test-mode)
- [Testing an integration and test scenarios](https://duffel.com/docs/api/overview/test-your-integration)
- [Offer Requests API v2](https://duffel.com/docs/api/v2/offer-requests)
- [Getting started and account activation](https://duffel.com/guides/getting-started)
- [Displaying offer and order conditions](https://duffel.com/docs/guides/displaying-offer-and-order-conditions)
- [Public pricing](https://duffel.com/pricing)
- [Services Agreement](https://duffel.com/services-agreement)

## Escalation triggers

Zatrzymaj implementację lub przyszły smoke, gdy warunki użycia, atrybucji, prezentacji,
persistence albo retencji są materialnie niejasne; test wymaga production account/live tokenu;
produktowa trasa wymaga test-only route; plan przekracza 1 request/1 attempt; konieczny jest
retry, fallback, pagination, polling, order/payment albo raw payload; nie da się użyć istniejącej
granicy 4B1; trzeba osłabić schema/redaction; preflight i runner nie zgadzają się fingerprintem;
albo request byłby potrzebny tylko do uzyskania zielonego PR. Brak użytecznej oferty po
jednorazowym zatwierdzonym smoke również jest eskalacją, nie zgodą na drugi request.

## Closeout evidence

- Implementacja 4B2 została zmergowana 2026-08-30 w PR #27. Merge commit to
  `main@bdf9cd5b5b63d9ae42a550d9411cf2342b76e082`, a ostatni head implementacyjny to
  `1d33d8528ab371991447a0d20487a76940cabd05`.
- Review wykrył jedną lukę semantyczną strict evidence: schema dopuszczała sprzeczne ręcznie
  skonstruowane kombinacje status/count/category. Poprawka i testy regresyjne zostały
  zmergowane w tym samym PR; po poprawce nie pozostały znane findingi blokujące.
- Przed merge `npm run verify:full` i `git diff --check` przeszły. Weryfikacja obejmowała 50
  plików i 953 testy jednostkowe, 6 plików i 128 testów integracyjnych oraz 2 testy E2E.
- Post-merge CI run
  [33316151852](https://github.com/pawszc/trip-planner/actions/runs/33316151852) dla exact merge
  SHA zakończył się `SUCCESS`.
- Implementacja, review, testy, CI i closeout wykonały: Duffel/external requests `0`,
  credential reads/use `0`, odczyty/wydruki/logi `.env` `0`, planowany koszt `0 USD` i
  rzeczywisty koszt `0 USD`.
- Żaden fingerprint preflightu sprzed merge nie jest ważną approval identity dla bieżącego
  `main`. Po merge nie uruchomiono `duffel:smoke:test`, nie odczytano tokenu i nie powstała
  zgoda na request. Nowy preflight należy wykonać dopiero z finalnego SHA po merge closeoutu.
- Pozycje `UNRESOLVED` z ADR 0012 nadal blokują production activation; nie blokują zamknięcia
  offline-only Phase 4B2 ani przyszłej, osobno zatwierdzonej pojedynczej próby w TEST.

## Definition of Done

- ADR/checklista, credential-free preflight, dormant runner, bezpieczny evidence schema i
  wszystkie wymagane testy są zmergowane na `main` w jednym branchu i PR 4B2.
- `npm run verify:full` oraz `git diff --check` przechodzą offline.
- PR raportuje exact source/head SHA, zakres per file, testy, odstępstwa, nierozstrzygnięte
  obowiązki, ryzyka, external/live calls, credential use oraz planowany i rzeczywisty koszt.
- W implementacji, testach, CI i review wykonano 0 Duffel requestów i użyto 0 credentiali.
- Ewentualny przyszły smoke pozostaje nieuruchomiony do osobnej zgody zgodnej z 4B2.4.
