# Schemas

`narrative-quality-v1.schema.json` pozostaje historycznym, niezmienionym kontraktem.
Aktualny `narrative-quality-v2.schema.json` jest frozen maszynowym kontraktem datasetu v2.
Offline loader waliduje nim cały plik, a następnie sprawdza dodatkowe invariants: exact
distribution, stable/unique IDs i fact keys, critical/sentinel membership, reason codes,
dimensions oraz canonical fingerprint.

`npm run eval:schema:check` generuje schema z `narrativeQualityDatasetSchema` przez
`z.toJSONSchema(...)`, dereferencjonuje lokalne definitions i normalizuje wyłącznie
kontrolowane elementy techniczne. Canonical comparison z frozen JSON wykrywa między innymi
drift `required`, properties, enum, min/max, `additionalProperties`, literalnej wersji,
liczby cases/contexts i zagnieżdżonych `requiredProperties`. Komenda jest wykonywana w
standardowym `verify` przed deterministic contract replay i nigdy nie nadpisuje golden.

Runtime strict schemas generation view, quality context, provider `GENERATE` blocks i
provider `JUDGE` findings pozostają w kodzie. Lokalne bindery dodają code-owned fingerprints,
deterministyczne disclosures i wyprowadzone dimension statuses; odrzucają unknown fields,
obce block/fact references oraz niespójne finding bindings przed użyciem outputu.
