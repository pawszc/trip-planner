# ADR 0001: CAP + React z deterministycznym rdzeniem

- Status: zaakceptowane
- Data: 2026-08-09

## Kontekst

Produkt potrzebuje trwałego modelu briefu, stabilnych reguł wykonalności i późniejszych integracji z providerami oraz modelami AI. Interfejs ma rozwijać się niezależnie od kontraktu domenowego.

## Decyzja

Używamy SAP CAP/Node.js z CDS i SQLite jako backendu oraz React/Vite z UI5 Web Components jako frontendowego workspace. Walidacja constraints, statusy i przyszłe kalkulacje kosztów pozostają w małych modułach TypeScript. Provider adapters, grounding, safety, ranking i LLM Gateway będą oddzielnymi warstwami.

## Konsekwencje

CAP dostarcza model, trwałość, OData i health endpoint przy małej ilości infrastruktury. React pozwala testować przepływ niezależnie. Podwójna granica wymaga jawnych typów i testów kontraktu. Model AI nie może nadpisywać wyników kodu; brak ceny pozostaje brakiem danych.
