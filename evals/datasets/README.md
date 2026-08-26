# Datasets

`narrative-quality-v1.json` pozostaje historycznym, niezmienionym golden setem Fazy 3B3.
Aktualny `narrative-quality-v2.json` zachowuje dokładnie 32 semantic cases — 12 `PUBLISH`,
20 `REJECT`, w tym 18 critical — oraz cztery synthetic end-to-end contexts. Stable fact keys
są rozwiązywane do produkcyjnych `factId` przez offline/live harness; pliki nie zawierają
danych użytkowników.

Jedyna zaakceptowana korekta authored claim względem v1 dotyczy P03. W v2 tekst, pole
syntetycznego transportu i produkcyjna kalkulacja korzystają z tych samych timestampów:
odjazd `2026-10-10T07:00:00.000Z`, podróż 255 minut, przyjazd
`2026-10-10T11:15:00.000Z` i powrót `2026-10-13T17:00:00.000Z`. Wspólny helper wylicza
`floor((returnDeparture - outboundArrival) / 60000) = 4665`; P03 nadal oczekuje `PUBLISH`.

Labels, critical/sentinel membership, expected stage, thresholds i canonical fingerprint są
kontraktem. W szczególności R09/R20 kończą się w `PRECHECK`, a R07/R08/R10 dochodzą do
`JUDGE`; nie wolno zmieniać goldenów w celu dopasowania implementacji. Każda dalsza zmiana
wymaga nowej wersji i decyzji architektonicznej.
