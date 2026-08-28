# Provider adapters

Interfejsy transportu, noclegów i miejsc izolują domenę od formatu konkretnego API.
Implementacje fixture działają bez internetu i generują dane względem dat jawnego requestu.
Phase 4B1 dodaje `DuffelApiTransportProvider` jako jawny profil `LIVE`, lecz nie włącza go
domyślnie i nie dodaje fallbacku. Standardowy profil produktu pozostaje fixture; testy Duffel
używają wyłącznie wstrzykniętego transportu HTTP w pamięci.

## Kontrakty 4B0

- `contracts.ts` definiuje provider-neutral requests/results, zamkniętą runtime identity
  adaptera oraz drugi argument z `AbortSignal` i run-scoped `executeUpstream`. Adapter live musi
  wykonać przez niego każdą rzeczywistą próbę create/poll/page/fan-out i potwierdzić exact
  manifest entry przed każdym fan-outem, również gdy zwróci pustą tablicę. Adapter nie może
  przenieść typu upstream API do domeny.
- `provider-manifest.ts` wymaga dokładnie jednej konfiguracji `TRANSPORT`, `ACCOMMODATION` i
  `PLACES`. `planning-provider-manifest-v1` wiąże mode, provider/adapter/upstream lineage,
  source contract i politykę wykonania w canonical JSON oraz SHA-256. Manifest nie zawiera
  sekretów, nagłówków, raw config ani base URL.
- `source-snapshot.ts` waliduje `source-snapshot-v2`. Query/result fingerprints powstają z
  allowlistowanych lokalnych reprezentacji; nie są hashami raw payloadów. `normalized-result.ts`
  obejmuje cały source-free DTO, a silnik ponownie sprawdza, że każdy kompletny snapshot wiąże
  dokładnie ten DTO. Live source nie ma `fixtureVersion`, fixture nie ma expiry, a kolizja
  snapshot ID z inną kanoniczną treścią kończy się fail-closed.
- Snapshot zachowuje nullable `sourceUrl`, `attribution` i `currency` bez wymyślania danych oraz
  wymaganą `termsPolicyVersion`, która wiąże display/cache/attribution policy.
- `offer-price-v2` w `domain/offer-pricing.ts` wiąże mandatory subtotal, obowiązkowe fees i
  all-in total. Conditional charges utrwalają label/condition/payable-at/mandatory semantics,
  a optional ancillaries własny label. Obie kolekcje mają jawny stan kompletności, ale
  pozostają nieaddytywnymi disclosures poza siedmioma kategoriami budżetu i rankingiem.
- `provider-execution.ts` tworzy run-scoped FIFO scope. Domyślne maksima to 10 000 ms, 25
  rzeczywistych source/upstream calls, concurrency 4 i jeden attempt; rate limit jest fail-fast,
  fallback to `NONE`, a
  override może limity tylko obniżyć. Błąd anuluje aktywne i oczekujące sibling calls.
- `provider-errors.ts` mapuje wyłącznie zamknięte kategorie i bezpieczne metadata. Raw
  request/response/error/header nie są częścią błędu ani audytu. Publiczny serwis zachowuje
  provider-neutral `PROVIDER_SEARCH_FAILED`.

Nowe runy zapisują `planning-request-fingerprint-v2` związany także z `offer-price-v2`, provider
manifest i jego fingerprint.
Legacy replay działa tylko dla manifestu identycznego z obecnym zamkniętym zestawem fixture,
w kolejności v2 → frozen v1 → exact v0, bez UPDATE i backfillu. Manifest live lub mieszany
nigdy nie może użyć historycznego wyniku fixture. Nie istnieje silent live → fixture fallback.
Frozen v1 replay obejmuje również historyczny `INSUFFICIENT_OPTIONS`; liczba eventów audytu
nowego runu jest związana z `PlanningRun`, więc utrata końcowego suffixu failuje replay.

## Adapter Duffel Phase 4B1

- `http/provider-http-client.ts` używa platformowego `fetch`, allowlistuje wyłącznie
  `https://api.duffel.com`, pobiera token dopiero w chwili requestu i nigdy nie przenosi body,
  headerów, tokenu ani raw błędu do wyjątku. Każdy request adaptera jest wykonywany przez
  run-scoped `executeUpstream`.
- `duffel-search-policy.ts` zamraża `duffel-search-policy-v1`: code-owned origin IATA,
  adults-only, economy, dwie slices, brak split ticket, maksymalnie jedna przesiadka, jeden
  offer request per destynacja, `return_offers=true`, `view=offers` i 8 s supplier timeout.
- `duffel-schemas.ts` waliduje wszystkie używane fakty Zod i stripuje pola spoza allowlisty.
  Mapper przyjmuje tylko spójne waluty PLN/EUR, dokładne `base + tax = total`, jednoznaczne
  lokalne timestampy z IANA timezone, ciągłe segmenty bez airport change oraz dwie odwrócone
  slices. Optional services pozostają disclosure i nie zwiększają mandatory total.
- Profil `TEST` nadal zapisuje `sourceType: LIVE`; jawne środowisko jest częścią
  `providerVersion` w manifeście i snapshotach. `fixtureVersion` pozostaje `null`.
- Sort, semantic dedup i truncation są lokalne i niezależne od upstream order. Pojedyncza
  niepoprawna oferta jest odrzucana, a błąd destynacji kończy cały search bez częściowego
  wyniku i bez fallbacku.

Kontrakty oparto na oficjalnych opisach Duffel:
[Offer Requests v2](https://duffel.com/docs/api/v2/offer-requests),
[Offers](https://duffel.com/docs/api/offers),
[Making requests](https://duffel.com/docs/api/overview/making-requests) i
[Response handling](https://duffel.com/docs/api/overview/response-handling).

`startPlanning` wykonuje krótki committed read/replay checkpoint, provider work bez aktywnej
transakcji DB oraz krótki write z rewalidacją briefu, workflow, manifestu, fingerprintu i
równoległego wyniku. Pełna decyzja i zasady migracji są opisane w
[ADR 0011](../../docs/decisions/0011-live-provider-contract-hardening.md).

Dormant smoke command nie został dodany: jest opcjonalny, a offline adapter, profile i testy nie
wymagają ścieżki odczytu credentials. Jakikolwiek przyszły smoke nadal wymaga osobnej zgody.
