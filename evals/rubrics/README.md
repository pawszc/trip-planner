# Rubrics

`narrative-quality-v1.md` opisuje osiem obowiązkowych wymiarów oceny, a
`narrative-quality-v1.json` jest checked-in, machine-readable golden reprezentacją tej samej
semantyki: definicji wymiarów, `PASS`/`FAIL`, zamkniętego katalogu reason codes oraz
mapowania reason → dimensions/severity. Typowany runtime contract ma canonical SHA-256;
parity i fingerprint tests wykrywają brak, dodatkowe pole lub nawet zmianę pojedynczego
znaku definicji. `JUDGE` otrzymuje pełny kontrakt, exact version i fingerprint, a nie samą
nazwę wersji.

Sędzia nie zwraca wiążącego overall verdict ani persistowalnego free-form rationale; kod
publikuje tylko przy ośmiu `PASS` i zerze findings. Nowe review i opublikowane narracje
zapisują exact `rubricFingerprint`; addytywne rekordy legacy pozostają `null`.

Rubryka, dataset, prompt, schemas i publication policy są wersjonowane razem. Zmiana
semantyki wymaga jawnej zmiany golden artifact, nowej wersji i nowego przechodzącego
baseline. Plik Markdown nie został przepisany przez implementację blockerów.
