# ADR 0012: Duffel test-mode activation readiness i granica produkcyjna

- Status: zaakceptowane dla offline-only Phase 4B2
- Data: 2026-08-30
- Zakres: credential-free preflight, dormant one-shot test-mode runner i production blockers
- Charakter: techniczno-operacyjna checklista, nie opinia prawna

## Kontekst

Phase 4B1 dostarczyła zweryfikowany offline adapter `DuffelApiTransportProvider`. Następny
krok ma przygotować kontrolowany test rzeczywistej granicy API bez włączania Duffel w
produkcie, zapisu wyników do bazy, orderu albo płatności. Sam fakt, że adapter działa na
fixture i mockowanym transporcie, nie rozstrzyga warunków komercyjnych, prezentacji danych
dostawców ani dopuszczalnego modelu produktu.

## Oficjalne fakty Duffel

Źródła zostały odczytane 2026-08-30. Poniższe punkty są streszczeniem dokumentacji i umowy,
nie decyzją projektu:

- [Test mode](https://duffel.com/docs/api/overview/test-mode) jest sandboxem do budowy
  integracji bez ryzyka wydania pieniędzy albo utworzenia niechcianej rezerwacji. Tokeny
  testowe zaczynają się od `duffel_test_` i nie mają dostępu do zasobów live.
- Zewnętrzne sandboxy linii lotniczych nie mają gwarantowanej dostępności. Duffel Airways jest
  stabilniejszym sandboxem, lecz jego rozkłady i ceny nie są realistyczne.
- [Scenariusze testowe](https://duffel.com/docs/api/overview/test-your-integration) zapewniają
  przewidywalne zachowania tylko dla wskazanych tras. Wyniki innych wyszukiwań mogą zmieniać
  się bez uprzedzenia; lista nie daje gwarancji dla `WRO → PRG → WRO`.
- [Offer Requests v2](https://duffel.com/docs/api/v2/offer-requests) oznacza test mode przez
  `live_mode=false`; podróż powrotna wymaga dwóch slices.
- [Aktywacja konta](https://duffel.com/guides/getting-started) wymaga weryfikacji emaila i
  procesu verification/KYC przed dostępem do Live Mode. Realne requesty wymagają live tokenu.
- [Warunki ofert i orderów](https://duffel.com/docs/guides/displaying-offer-and-order-conditions)
  są zwracane w `conditions`. Mogą być częściowo nieznane, a informacja o dozwolonej zmianie
  lub refundzie może nie zawierać kwoty kary.
- [Publiczny cennik](https://duffel.com/pricing) w wariancie USD podaje obecnie 3 USD za
  potwierdzony order, 1% wartości potwierdzonego orderu dla Managed Content, 2 USD za płatny
  ancillary, 0,005 USD za excess search ponad wskaźnik 1500:1 oraz 2% przy wymaganym FX.
  Są to informacje publiczne na dzień odczytu, nie zamrożona oferta dla projektu.
- [Services Agreement](https://duffel.com/services-agreement) wiąże Agreement z ewentualnym
  Order Form, definiuje fair usage i Search-to-Order Ratio według pricing page albo Order
  Form, wymaga stosowania Documentation i reguł Supplierów oraz pozwala Duffel sprawdzić
  prezentację Supplier Data. Umowa zawiera też ograniczenie użycia do metasearch oraz odrębne
  obowiązki dotyczące danych osobowych.

## Decyzja projektu

### Trzy niezależne bramki

1. `OFFLINE_READINESS`: implementacja planu, runnera, schematu evidence i testów nie używa
   credentiali ani sieci.
2. `ONE_SHOT_TEST_SMOKE`: wymaga osobnej zgody na dokładny commit i fingerprint planu.
3. `PRODUCTION_ACTIVATION`: pozostaje zablokowana do zamknięcia wszystkich pozycji
   `UNRESOLVED` poniżej. Udany smoke nie odblokowuje produkcji.

### Zamrożony scenariusz smoke

- jedyna trasa: produktowe `WRO → PRG → WRO`;
- 1 dorosły, economy, PLN, przyszłe daty podane jawnie do preflightu;
- dokładnie 1 logiczny search i 1 fizyczny Create Offer Request;
- `maxCalls=1`, `maxConcurrency=1`, `maxAttempts=1`, retry 0, `FAIL_FAST`, fallback `NONE`;
- bez pagination, polling, offer refresh, order, payment i zapisu produktu;
- sukces wymaga `live_mode=false` i co najmniej jednej oferty przechodzącej istniejący schemat
  oraz mapper 4B1. HTTP 2xx ani pusta odpowiedź nie są sukcesem integracji;
- brak użytecznej oferty kończy run i wymaga eskalacji. Runner nie przełącza się na test-only
  route i nie wykonuje drugiego requestu.

### Approval binding i credential boundary

`duffel:smoke:preflight` działa bez `process.env`, tokenu i transportu. Czyta wyłącznie HEAD
oraz informację clean/dirty, waliduje daty i tworzy kanoniczny plan związany z source SHA,
wersjami adaptera/schema/policy/manifestu, query fingerprintem i limitami.

`duffel:smoke:test` nie ładuje `.env`. Wymaga jednocześnie:

- `DUFFEL_SMOKE_ENABLED=true`;
- `DUFFEL_SMOKE_APPROVED_PLAN_FINGERPRINT` równego bieżącemu preflightowi;
- tokenu z kanału `DUFFEL_ACCESS_TOKEN`, którego tożsamość zaczyna się od `duffel_test_`.

Brak opt-in albo mismatch planu kończy się przed odczytem tokenu. Token live lub token o
nieznanej tożsamości kończy się po pojedynczym credential read, ale przed network. Wartość
sekretu nigdy nie trafia do wyniku.

### Evidence i koszt

Evidence jest zamkniętym schematem z SHA/fingerprintami, wersjami, środowiskiem `TEST`,
czasem, latency, licznikami 0–1, bezpiecznym statusem HTTP, result count/fingerprint i
zamkniętą kategorią. Nie ma pól na raw request/response, ofertę, cenę, offer ID, przewoźnika,
headers, token, provider text, exception message ani stack.

Publiczny opis test mode uzasadnia deterministyczny estimate 0 USD dla planowanego
jednorazowego testu. Kod raportuje koszt w integer USD micros. Jest to estimate testu, a nie
gwarancja cennika live.

## Production activation blockers

| Stan         | Właściciel            | Problem i wymagane rozstrzygnięcie                                                                                                                                                                              |
| ------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNRESOLVED` | Product + Legal       | Potwierdzić z Duffel, czy model Trip Planner nie narusza umownego zakazu metasearch, albo uzyskać właściwe pisemne uprawnienie/Order Form.                                                                      |
| `UNRESOLVED` | Product + Legal       | Ustalić kompletną listę Supplier display rules, branding/attribution i obowiązków prezentacji przed włączeniem wyników dla użytkowników.                                                                        |
| `UNRESOLVED` | Engineering + Product | Obecny UI pokazuje provider i kontekst źródła, ale nie pełną atrybucję operating carrier ani warunki change/refund; zaprojektować i przetestować fail-closed publiczny kontrakt.                                |
| `UNRESOLVED` | Privacy + Legal       | Określić dopuszczalny zakres persistence i retencji Supplier Data, external offer IDs, cen, warunków oraz przyszłych danych podróżnych; publiczna umowa nie jest dla projektu wystarczającą decyzją retencyjną. |
| `UNRESOLVED` | Finance + Operations  | Potwierdzić aktywny plan, walutę rozliczenia, Dashboard/Order Form, Search-to-Order Ratio, Managed Content, FX i odpowiedzialność za monitoring kosztu przed live.                                              |
| `UNRESOLVED` | Operations + Legal    | Ukończyć verification/KYC, model płatności, merchant/seller responsibilities, support i proces obsługi zmian/refundów przed orderem.                                                                            |

Każda pozycja musi otrzymać dowód, datę review i status `RESOLVED` w osobnym kontrakcie
production activation. Model ani implementacja nie mogą domniemać rozstrzygnięcia.

## Konsekwencje

- Można bezpiecznie zaimplementować i zreviewować całą ścieżkę smoke offline.
- Po merge można przygotować jednorazową prośbę o test-mode request z dokładnymi datami i
  fingerprintem. Ta decyzja nadal nie jest zgodą na request.
- Nie wolno włączyć Duffel w `TripPlannerService`, UI ani persistence produktu w Phase 4B2.
- Udany test potwierdzi kompatybilność transportu/schema/mappera tylko dla jednego payloadu
  sandboxa; nie dowiedzie dostępności, jakości rozkładów, realistyczności cen ani gotowości
  produkcyjnej.

## Rollback

Runner i preflight są addytywne oraz wyłączone z `verify`, `verify:full`, CI i standardowego
startu. Rollback usuwa oba commandy i moduły smoke bez zmiany adaptera 4B1, domeny,
persistence, Search Policy v1 albo profilu produktu.
