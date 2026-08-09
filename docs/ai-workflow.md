# Przyszły przepływ AI

1. Kod waliduje constraints i usuwa niewykonalne kandydatury.
2. Grounding wiąże aktualne fakty z `SourceSnapshot` i wykrywa braki.
3. Tani model wykonuje proste decyzje klasyfikacyjne na danych o ustalonym schemacie.
4. Mocniejszy model generuje trzy różne warianty i opisuje kompromisy, bez liczenia kosztów.
5. Osobny safety check kontroluje zgodność, ryzyka i zakazane poluzowanie ograniczeń.
6. Plan dzień po dniu powstaje dopiero po wyborze wariantu.

Prompty będą wersjonowane, a każda zmiana będzie oceniana na stabilnych datasetach, schematach i rubrykach w `evals/`.
