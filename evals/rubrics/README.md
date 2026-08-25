# Rubrics

Pliki `narrative-quality-v1.md` i `narrative-quality-v1.json` pozostają historycznym,
niezmienionym kontraktem. Aktualne `narrative-quality-v2.md` i
`narrative-quality-v2.json` opisują osiem obowiązkowych wymiarów, code-derived `PASS`/`FAIL`,
zamknięty katalog reason codes oraz jawne mapowanie reason → dimensions/severity. Typowany
runtime contract ma canonical SHA-256;
parity i fingerprint tests wykrywają brak, dodatkowe pole lub nawet zmianę pojedynczego
znaku definicji. `JUDGE` otrzymuje pełny kontrakt, exact version i fingerprint, a nie samą
nazwę wersji.

Sędzia zwraca wyłącznie zamknięte findings, bez fingerprintów, dimension statuses, wiążącego
overall verdict ani persistowalnego free-form rationale. Kod wiąże output z exact requestem,
wyprowadza osiem statuses i publikuje tylko przy zerze findings. Nowe review i opublikowane narracje
zapisują exact `rubricFingerprint`; addytywne rekordy legacy pozostają `null`.

Rubryka, dataset, prompt, schemas i publication policy są wersjonowane razem. Zmiana
semantyki wymaga jawnej zmiany golden artifact, nowej wersji i nowego przechodzącego
baseline. Offline contract audit dowodzi zgodności expected dimensions/reasons i critical severity
datasetu v2 z dokładnie tą rubryką.
