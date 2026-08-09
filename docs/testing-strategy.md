# Strategia testów

- Testy jednostkowe uruchamiają czystą walidację domenową i przejścia stanu bez UI i bazy.
- Testy integracyjne uruchamiają prawdziwy serwer CAP z bazą SQLite in-memory i sprawdzają kontrakt OData.
- Jeden stabilny test Playwright przechodzi cały obecny przepływ w Chromium. Przy błędzie zachowuje screenshot, trace i raport HTML.
- Pull requesty używają danych mockowanych lub lokalnych; nie kontaktują się z płatnymi ani niestabilnymi providerami.
- Przyszłe evale LLM mierzą grounding, zgodność i różnorodność, ale nie zastępują testów kodu.
- Późniejsze smoke testy live API będą osobnym, kontrolowanym workflow z sekretami spoza repozytorium.

`npm run verify` obejmuje lint, typecheck, unit, integration i build. `npm run verify:full` dodaje E2E.
