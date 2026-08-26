# Prompts

Prompty są wersjonowane jak kod. Każda wersja ma jednoznaczny identyfikator oraz powiązane
wersje wejścia i strict output schema.

Aktywny prompt produktu to `grounded-option-narrative-prompt-v3`, zdefiniowany razem ze
schematem `grounded-option-narrative-schema-v2` w `srv/narratives/option-narrative.ts`.
Wersja v3 wiąże `GENERATE` z exact `narrative-generation-view-v1`, który zawiera wyłącznie
dozwolone fakty `KNOWN`, bez provenance oraz wartości `UNKNOWN`/`MISSING`. Provider zwraca
tylko `{blocks}` z najwyżej sześcioma blokami i nie jest właścicielem fingerprintu ani
obowiązkowych disclosures. Kod waliduje `factReferences`, wstrzykuje exact fingerprint,
dokłada deterministyczny tail i waliduje finalny limit ośmiu bloków przed wersjonowanym
precheckiem i strict `JUDGE`. Historyczne prompt v2/schema v1 pozostają identyfikatorami
ścieżki używającej `narrative-model-view-v1`, a v1 — ścieżki 3B2 otrzymującej pełny grounded
context.
