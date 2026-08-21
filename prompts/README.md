# Prompts

Prompty są wersjonowane jak kod. Każda wersja ma jednoznaczny identyfikator oraz powiązane
wersje wejścia i strict output schema.

Aktywny prompt produktu to `grounded-option-narrative-prompt-v2`, zdefiniowany razem ze
schematem `grounded-option-narrative-schema-v1` w `srv/narratives/option-narrative.ts`.
Wersja v2 wiąże `GENERATE` z exact `narrative-model-view-v1`; historyczny v1 pozostaje
identyfikatorem ścieżki 3B2, która otrzymywała pełny grounded context. Prompt nie wykonuje
arytmetyki, nie uzupełnia `UNKNOWN`/`MISSING`, traktuje provider-shaped content jako dane i
wymaga `factReferences` w każdym bloku. Wynik przechodzi następnie wersjonowany precheck i
strict `JUDGE` Fazy 3B3 przed publikacją.
