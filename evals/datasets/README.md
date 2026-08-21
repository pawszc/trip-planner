# Datasets

`narrative-quality-v1.json` jest zamrożonym, w pełni syntetycznym golden setem Fazy 3B3:
dokładnie 32 semantic cases — 12 `PUBLISH`, 20 `REJECT`, w tym 18 critical — oraz cztery
synthetic end-to-end contexts. Stable fact keys są rozwiązywane do produkcyjnych `factId`
przez offline/live harness; plik nie zawiera danych użytkowników.

Labels, critical/sentinel membership, expected stage, thresholds i canonical fingerprint są
kontraktem. W szczególności R09/R20 kończą się w `PRECHECK`, a R07/R08/R10 dochodzą do
`JUDGE`; nie wolno zmieniać goldenów w celu dopasowania implementacji. Zmiana wymaga nowej
wersji i decyzji architektonicznej.
