# ADR 0005: Vendor-neutral LLM Gateway i bezpieczne credentiale

- Status: zaakceptowane
- Data: 2026-08-12

## Kontekst

Kolejne fazy potrzebują LLM do ograniczonych decyzji i generowania tekstu, ale rdzeń
planera musi pozostać deterministyczny. Integracja nie może przywiązać domeny do jednego
SDK, wymagać credentiali przy starcie ani dopuścić, aby model liczył budżet, uzupełniał
brakujące fakty lub cicho poluzował constraints. Testy repozytorium muszą pozostać w pełni
offline i bezkosztowe.

OpenAI i Anthropic mają różne kontrakty requestów, structured output, usage, błędów i
retry. Potrzebujemy wspólnej granicy, która zachowa różnice wyłącznie w adapterach.

## Decyzja

Wprowadzamy własny, mały `StructuredAiAdapter` i `AiGateway`. Kontrakt zawiera typ zadania,
wersje promptu i schematu, ugruntowany JSON, lokalny schemat Zod oraz vendor-neutral wynik.
`DECIDE`, `JUDGE` i `SMOKE` domyślnie trafiają do OpenAI, a `GENERATE` do Anthropic.
Konfiguracja i per-request override są jawne. Nie implementujemy fallbacku między
providerami ani modelami.

OpenAI integrujemy przez oficjalny pakiet `openai` i Responses API, nie Assistants API.
Responses API jest bezpośrednim, aktualnym interfejsem dla pojedynczych strukturalnych
wywołań i nie wprowadza niepotrzebnego lifecycle threads/runs. Używamy
`responses.parse` oraz `zodTextFormat`, a request jawnie zawiera `store: false`. Aplikacja
nie utrwala dzięki temu obiektu odpowiedzi przez Responses API. `store: false` nie jest
jednak gwarancją Zero Data Retention i nie wyklucza wszystkich logów bezpieczeństwa ani
abuse monitoringu po stronie providera. Przed przesłaniem prawdziwych danych użytkowników
trzeba osobno zweryfikować ustawienia retencji organizacji, warunki prywatności, dostępność
ZDR i dozwolony zakres danych.

Anthropic integrujemy przez oficjalny `@anthropic-ai/sdk` i Messages API, nie Claude Code.
Messages API jest programistycznym API modelu dla backendu; Claude Code jest narzędziem
agentowym do pracy z repozytorium, a nie runtime produktu. Używamy stable
`output_config.format` oraz `zodOutputFormat`.

Dodajemy `zod` jako jedyną bibliotekę schematów. Ten sam schemat opisuje oczekiwany wynik,
pomaga SDK zażądać structured output i obowiązkowo waliduje odpowiedź lokalnie. Nie
dodajemy frameworka agentowego: obecny routing to mała, typowana granica bez tools,
orkiestracji agentów, pamięci ani streamingu.

Wersje `openai`, `@anthropic-ai/sdk` i `zod` są przypięte dokładnie w `package.json` i
lockfile. Każda zależność ma pojedyncze uzasadnienie:

- `openai` — oficjalne typy, transport, Responses API, retry i structured output OpenAI;
- `@anthropic-ai/sdk` — oficjalne typy, transport, Messages API, retry i structured output
  Anthropic;
- `zod` — jeden lokalny kontrakt runtime, ponowna walidacja i typowanie wyniku.

Modele pozostają konfigurowalne, ponieważ dostęp kont, aliasy i koszt mogą się różnić.
Domyślne wartości są jawne, a błąd dostępu wskazuje konkretną zmienną do zmiany. Kod nigdy
nie zgaduje modelu zastępczego.

Konfiguracja jest ładowana przez czystą funkcję bez import-time side effects. Klient SDK
powstaje leniwie dopiero przy wywołaniu. `AI_ENABLED=false` wyłącza produktowy gateway,
a `AI_LIVE_SMOKE_ENABLED=false` niezależnie blokuje live smoke. Credentiale są wymagane
wyłącznie dla faktycznie wybranego adaptera.

Testy adapterów korzystają z dependency-injected transportu HTTP in-memory. Weryfikują
payload tworzony przez prawdziwe SDK bez globalnego monkey patchingu, internetu i
credentiali. Live smoke jest ręcznym, minimalnym i potencjalnie płatnym workflow poza CI,
`verify` oraz `verify:full`.

Bezpieczna telemetria zachowuje tylko metadane i fingerprint wejścia. Nie przechowuje
promptów, pełnych payloadów, nagłówków ani credentiali. Persystencję `AiRuns` świadomie
odkładamy do Fazy 3B, kiedy będzie znany produktowy lifecycle, retencja i wymagania
prywatności.

## Warunki wejścia do Fazy 3B

Przed pierwszym produkcyjnym wywołaniem decyzja wymaga uzupełnienia projektu o:

1. Task-aware routing z osobnym, jawnym profilem `provider + model + effort + max output
tokens` dla `DECIDE`, `GENERATE` i `JUDGE`.
2. Asynchroniczny recorder przygotowany do persistence.
3. Rozdzielenie metadanych `configuredModel` i `responseModel`.
4. Jawną politykę awarii recordera: `fail-open` albo `fail-closed`.
5. Walidację zwracanych przez adapter metadanych: provider, task type, prompt version,
   schema version i input fingerprint.

Są to obowiązkowe bramki Fazy 3B, a nie elementy implementowane w Fazie 3A.

## Konsekwencje

Domena i przyszłe use case'y nie zależą od typów dostawców, można testować realny kształt
requestów całkowicie offline, a start aplikacji pozostaje możliwy bez sekretów. Podwójna
walidacja — po stronie providera i lokalnie — ogranicza ryzyko wykorzystania niezgodnego
wyniku. Zamknięte błędy, redakcja i brak payloadów w telemetrii zmniejszają ryzyko wycieku.

Kosztem są dwa adaptery i świadome mapowanie różnic w usage, refusal oraz błędach. Brak
fallbacku obniża dostępność pojedynczego wywołania, ale zachowuje przewidywalny koszt,
model i semantykę. Live smoke nie daje deterministycznej gwarancji, ponieważ zależy od
zewnętrznej sieci, limitów, salda i dostępu do modelu; dlatego uzupełnia, a nie zastępuje,
testy offline.
