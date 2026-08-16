# Schemas

`narrative-quality-v1.schema.json` jest frozen maszynowym kontraktem datasetu Fazy 3B3.
Offline loader waliduje nim cały plik, a następnie sprawdza dodatkowe invariants: exact
distribution, stable/unique IDs i fact keys, critical/sentinel membership, reason codes,
dimensions oraz canonical fingerprint.

Runtime strict schemas model view, quality context i `JUDGE` pozostają w kodzie i odrzucają
unknown fields, brakujące/duplikowane dimensions, obce block/fact references oraz mismatched
fingerprints przed użyciem outputu.
