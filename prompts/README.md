# Prompts

Prompty są wersjonowane jak kod. Każda wersja ma jednoznaczny identyfikator oraz powiązane
wersje wejścia i strict output schema.

Pierwszym aktywnym promptem produktu jest `grounded-option-narrative-prompt-v1`, zdefiniowany
razem ze schematem `grounded-option-narrative-schema-v1` w
`srv/narratives/option-narrative.ts`. Prompt obsługuje wyłącznie zadanie `GENERATE`, nie
wykonuje arytmetyki, nie uzupełnia `UNKNOWN`/`MISSING` i wymaga `factReferences` w każdym
bloku. Evale oraz `JUDGE` pozostają poza Fazą 3B2.
