# Provider adapters

Interfejsy transportu, noclegów i miejsc izolują domenę od formatu konkretnego API.
Obecne implementacje fixture działają bez internetu, generują dane względem dat jawnego
requestu i pozostają jedynymi skonfigurowanymi adapterami Phase 4B0. Celowo niepoprawne
rekordy służą testom filtrów. Phase 4B0 nie implementuje `DuffelApiTransportProvider` ani
żadnego innego live adaptera.

## Kontrakty 4B0

- `contracts.ts` definiuje provider-neutral requests/results, zamkniętą runtime identity
  adaptera oraz opcjonalny drugi argument z `AbortSignal`. Adapter live musi potwierdzić exact
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
- `offer-price-v2` w `domain/offer-pricing.ts` wiąże mandatory subtotal, obowiązkowe fees i
  all-in total. Conditional charges i optional ancillaries mają jawny stan kompletności, ale
  pozostają nieaddytywnymi disclosures poza siedmioma kategoriami budżetu i rankingiem.
- `provider-execution.ts` tworzy run-scoped FIFO scope. Domyślne maksima to 10 000 ms, 25
  calls, concurrency 4 i jeden attempt; rate limit jest fail-fast, fallback to `NONE`, a
  override może limity tylko obniżyć. Błąd anuluje aktywne i oczekujące sibling calls.
- `provider-errors.ts` mapuje wyłącznie zamknięte kategorie i bezpieczne metadata. Raw
  request/response/error/header nie są częścią błędu ani audytu. Publiczny serwis zachowuje
  provider-neutral `PROVIDER_SEARCH_FAILED`.

Nowe runy zapisują `planning-request-fingerprint-v2` związany także z `offer-price-v2`, provider
manifest i jego fingerprint.
Legacy replay działa tylko dla manifestu identycznego z obecnym zamkniętym zestawem fixture,
w kolejności v2 → frozen v1 → exact v0, bez UPDATE i backfillu. Manifest live lub mieszany
nigdy nie może użyć historycznego wyniku fixture. Nie istnieje silent live → fixture fallback.

## Granica przyszłej integracji

Adapter live powinien być małym modułem REST-first. Transport HTTP, authentication,
pagination, rate-limit metadata, provider-specific schema i mapowanie pozostają wewnątrz
adaptera. Dopiero lokalnie zwalidowany, znormalizowany wynik może przejść do candidate engine.
Użycie oficjalnego SDK wymaga osobnego uzasadnienia i nie zmienia tej granicy.

Implementacja live, opt-in/credentials oraz refaktor `startPlanning` do krótkiego read →
network bez otwartej transakcji → krótkiego write należą do 4B1. Nie są częścią 4B0. Pełna
decyzja i zasady migracji są opisane w
[ADR 0011](../../docs/decisions/0011-live-provider-contract-hardening.md).
