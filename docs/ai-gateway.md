# LLM Gateway Fazy 3A

## Cel i granice

Faza 3A wprowadza vendor-neutral granicę dla przyszłych wywołań LLM. Nie zmienia działania
`startPlanning`, CAP, UI, deterministycznego rankingu ani persistence. Gateway pozostaje
domyślnie wyłączony i nie wykonuje żadnego requestu podczas importu, buildu, startu ani
standardowych testów.

Twarde ograniczenia, kompletność danych, workflow, scoring i wszystkie obliczenia finansowe
pozostają odpowiedzialnością kodu. Model otrzymuje wyłącznie jawne, ugruntowane dane JSON.
Braków nie wolno ukrywać ani uzupełniać przez model.

## Moduły

- `srv/ai/contracts.ts` — publiczne typy providerów, zadań, requestów, wyników i usage;
- `srv/ai/config.ts` — czysty loader konfiguracji i walidacja granic;
- `srv/ai/ai-gateway.ts` — routing, per-request override i brak fallbacku;
- `srv/ai/adapters/` — izolowane adaptery oficjalnych SDK;
- `srv/ai/errors.ts` — zamknięty katalog bezpiecznych błędów;
- `srv/ai/redaction.ts` — redakcja sekretów i wrażliwych nagłówków;
- `srv/ai/telemetry.ts` — vendor-neutral metadata bez promptów i payloadów;
- `srv/ai/live-smoke.ts` — minimalny, jawnie aktywowany test live;
- `scripts/ai-*.ts` — bezpieczne punkty wejścia dla operatora.

Typy OpenAI i Anthropic nie opuszczają adapterów. Publiczny `srv/ai/index.ts` eksportuje
klasy adapterów, ale nie eksportuje ich fabryk klientów, opcji transportu, wrapperów
request/response ani test seams. Pozostały kod zależy tylko od `StructuredAiAdapter` i
`AiCallResult`.

## Kontrakt strukturalnego wywołania

`StructuredAiRequest<T>` zawiera:

- typ zadania: `DECIDE`, `GENERATE`, `JUDGE` albo `SMOKE`;
- jawne `promptVersion`, `schemaName` i `schemaVersion`;
- instrukcje i ugruntowane wejście zgodne z typem JSON;
- schemat Zod wyniku;
- opcjonalny limit tokenów i jawny override providera.

Gateway kanonizuje JSON przez rekurencyjne sortowanie kluczy i tworzy SHA-256 fingerprint.
Surowe wejście nie trafia do telemetrii. Wynik zawiera zwalidowane `output`, provider,
model, wersje, fingerprint, usage, latency, liczbę faktycznych prób, identyfikator requestu
providera, jeśli jest dostępny, oraz stan refusal.

## Routing

| Zadanie    | Domyślny provider                           |
| ---------- | ------------------------------------------- |
| `DECIDE`   | `AI_DECIDE_PROVIDER`, domyślnie OpenAI      |
| `JUDGE`    | `AI_DECIDE_PROVIDER`, domyślnie OpenAI      |
| `SMOKE`    | `AI_DECIDE_PROVIDER`, domyślnie OpenAI      |
| `GENERATE` | `AI_GENERATE_PROVIDER`, domyślnie Anthropic |

Override w requeście może wybrać zarejestrowany adapter. Gateway nie przełącza się po
błędzie na drugiego providera, inny model ani mniej rygorystyczny schemat. Brak adaptera
kończy się `UNSUPPORTED_AI_PROVIDER`, a `AI_ENABLED=false` kończy zwykłe wywołanie
`AI_DISABLED`.

## Adapter OpenAI

Adapter używa oficjalnego pakietu `openai` i Responses API. `responses.parse` otrzymuje
format z `zodTextFormat`, `store: false`, pusty zestaw narzędzi, jawny model, effort i limit
output tokens. Parsed output jest ponownie sprawdzany przez lokalny schemat Zod. Refusal,
brak parsed output albo niezgodność schematu są kontrolowanymi błędami.

Domyślny model to `gpt-5.6-luna`, a effort `none`. Model jest konfigurowalny wyłącznie przez
`OPENAI_DECIDE_MODEL` i nigdy nie jest cicho zastępowany.

## Adapter Anthropic

Adapter używa oficjalnego `@anthropic-ai/sdk` i Messages API. `messages.create` otrzymuje
stable structured output w `output_config.format` wygenerowany przez `zodOutputFormat`,
wyłączone thinking, brak tools, jawny model, effort i limit output tokens. Adapter akceptuje
structured output wyłącznie dla `stop_reason=end_turn`. `refusal` jest mapowany na
`MODEL_REFUSAL`, a każdy inny lub brakujący stop reason jest odrzucany przed parsowaniem.
Po `end_turn` wymagany jest dokładnie jeden niepusty blok tekstowy; dopiero ten blok jest
parsowany jako JSON i ponownie sprawdzany przez lokalny schemat Zod. Brak treści, wiele
bloków, błędny JSON i niezgodność schematu są kontrolowanymi błędami.

Domyślny model to `claude-sonnet-5`, a effort `low`. Model jest konfigurowalny wyłącznie
przez `ANTHROPIC_GENERATE_MODEL` i nigdy nie jest cicho zastępowany.

## Konfiguracja

`loadAiConfig` jest funkcją czystą: nie czyta `process.env` samodzielnie. Wywołujący
przekazuje środowisko jawnie. Brak klucza jest dopuszczalny aż do faktycznego wywołania
wybranego adaptera.

| Zmienna                    | Domyślna wartość  | Walidacja                                          |
| -------------------------- | ----------------- | -------------------------------------------------- |
| `AI_ENABLED`               | `false`           | dokładnie `true` lub `false`                       |
| `AI_LIVE_SMOKE_ENABLED`    | `false`           | dokładnie `true` lub `false`                       |
| `AI_DECIDE_PROVIDER`       | `openai`          | `openai` albo `anthropic`                          |
| `AI_GENERATE_PROVIDER`     | `anthropic`       | `openai` albo `anthropic`                          |
| `OPENAI_DECIDE_MODEL`      | `gpt-5.6-luna`    | niepusty tekst                                     |
| `OPENAI_REASONING_EFFORT`  | `none`            | `none`, `low`, `medium`, `high`, `xhigh` lub `max` |
| `ANTHROPIC_GENERATE_MODEL` | `claude-sonnet-5` | niepusty tekst                                     |
| `ANTHROPIC_EFFORT`         | `low`             | `low`, `medium`, `high`, `xhigh` lub `max`         |
| `AI_TIMEOUT_MS`            | `30000`           | liczba całkowita 1000–120000                       |
| `AI_MAX_RETRIES`           | `1`               | liczba całkowita 0–2                               |
| `AI_MAX_OUTPUT_TOKENS`     | `128`             | liczba całkowita 1–8192                            |
| `OPENAI_API_KEY`           | brak              | wymagany dopiero przez adapter OpenAI              |
| `ANTHROPIC_API_KEY`        | brak              | wymagany dopiero przez adapter Anthropic           |

Limit z requestu może tylko obniżyć skonfigurowany `AI_MAX_OUTPUT_TOKENS`. Niepoprawna
konfiguracja kończy się przed wywołaniem sieciowym.

## Credentiale i zasady bezpieczeństwa

`.env.example` dokumentuje wyłącznie nazwy zmiennych i bezpieczne wartości domyślne.
`.env` jest ignorowany przez Git i nie wolno go otwierać, wypisywać, logować ani
commitować. Klucze przekazuje się tylko przez lokalne środowisko lub nieśledzony `.env`.

`npm run ai:credentials:check` sprawdza jedynie, czy zmienne są ustawione. Raportuje
`configured`/`missing`, nazwy modeli i stan live opt-in, nigdy wartości kluczy.

Redakcja obejmuje:

- pola o nazwach kluczy, tokenów, sekretów i haseł;
- nagłówki `Authorization` i `x-api-key`;
- typowe prefiksy kluczy OpenAI i Anthropic w tekście;
- zagnieżdżone obiekty, tablice i struktury cykliczne.

Surowy błąd SDK pozostaje nieenumerowalnym `cause`. Publiczna serializacja błędu zawiera
tylko kontrolowany kod, bezpieczny komunikat, retryability, provider, model i ograniczone
details. Nigdy nie zawiera promptu, pełnego requestu lub response, nagłówków ani credentiali.

### `store: false` a retencja danych

Adapter OpenAI wysyła `store: false`, więc aplikacja nie utrwala obiektu odpowiedzi przez
Responses API. To ustawienie nie jest jednak samo w sobie gwarancją Zero Data Retention
(ZDR) i nie oznacza automatycznie braku wszystkich logów bezpieczeństwa lub abuse
monitoringu po stronie providera.

Przed przesłaniem prawdziwych danych użytkowników w Fazie 3B trzeba osobno zweryfikować:

- ustawienia retencji organizacji;
- warunki prywatności;
- dostępność i zakres Zero Data Retention;
- zakres danych, które wolno przesłać do providera.

## Zamknięty katalog błędów

- konfiguracja i dostęp: `AI_DISABLED`, `LIVE_AI_NOT_ENABLED`,
  `MISSING_CREDENTIALS`, `INVALID_AI_CONFIGURATION`, `UNSUPPORTED_AI_PROVIDER`;
- provider: `AUTHENTICATION_FAILED`, `MODEL_ACCESS_DENIED`, `RATE_LIMITED`,
  `AI_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`;
- wynik: `MODEL_REFUSAL`, `EMPTY_MODEL_OUTPUT`, `INVALID_STRUCTURED_OUTPUT`.

Statusy 401, 403/404, 429, timeout, błędy połączenia i 5xx są mapowane niezależnie od SDK.
Przy braku dostępu do modelu bezpieczny błąd wskazuje nazwę zmiennej konfiguracyjnej do
zmiany; kod nie wybiera zamiennika automatycznie.

## Retry, timeout i obserwowalność

Każdy klient SDK otrzymuje jawny timeout oraz `maxRetries`. Licznik `attempts` pochodzi z
rzeczywistych prób transportu HTTP, a nie z założenia o zachowaniu SDK. Gateway nie dokłada
własnej pętli retry.

Recorder telemetrii otrzymuje wyłącznie: provider, model, typ zadania, wersje promptu i
schematu, fingerprint, czas, próby, usage, cache, request ID, refusal i bezpieczny kod
błędu. Domyślna implementacja niczego nie zapisuje. Trwała encja `AiRuns` jest odłożona do
Fazy 3B.

## Testy offline i ręczny smoke

Testy jednostkowe podają adapterom lokalny transport HTTP i sprawdzają payloady tworzone
przez rzeczywiste SDK. Obejmują routing, structured output, lokalną walidację, usage,
refusal, timeout, retry, błędy i redakcję. Nie patchują globalnego `fetch`, nie wymagają
kluczy i nie korzystają z sieci.

Ręczne komendy live:

```sh
npm run ai:credentials:check
npm run ai:smoke:openai
npm run ai:smoke:anthropic
npm run ai:smoke
```

Każdy smoke wymaga `AI_LIVE_SMOKE_ENABLED=true` i wykonuje dokładnie jeden minimalny
request do wskazanego providera. Oczekiwany wynik ma ścisły kształt
`{ "ok": true, "phase": "3a", "check": "structured-output" }`. Skrypty live nie należą do
`verify`, `verify:full` ani CI i nie wolno ich uruchamiać bez świadomej zgody na zewnętrzne,
potencjalnie płatne wywołanie.

## Warunki wejścia do Fazy 3B

Przed pierwszym produkcyjnym wywołaniem LLM trzeba zaprojektować i zatwierdzić:

1. Task-aware routing, który dla każdego zadania jawnie wskazuje pełny profil wywołania:

   | Zadanie    | Wymagana konfiguracja                         |
   | ---------- | --------------------------------------------- |
   | `DECIDE`   | provider + model + effort + max output tokens |
   | `GENERATE` | provider + model + effort + max output tokens |
   | `JUDGE`    | provider + model + effort + max output tokens |

2. Asynchroniczny recorder przygotowany do persistence, bez blokowania ścieżki requestu.
3. Jawne rozróżnienie `configuredModel` od `responseModel`.
4. Politykę błędów recordera: świadomy wybór `fail-open` albo `fail-closed`.
5. Walidację metadanych zwracanych przez adapter: provider, task type, prompt version,
   schema version i input fingerprint.

Te elementy są obowiązkowymi bramkami projektowymi przed Fazą 3B; Faza 3A ich nie
implementuje.

## Znane ograniczenia

- gateway nie jest jeszcze używany przez produkt;
- nie ma produkcyjnych promptów, evali, safety pipeline ani `AiRuns`;
- nie ma fallbacku i awaria skonfigurowanego providera kończy wywołanie;
- smoke zależy od sieci, salda, limitów i dostępu konta do dokładnie skonfigurowanego modelu;
- adaptery obsługują wyłącznie tekstowy structured output, bez tools, obrazów i streamingu;
- telemetria ma interfejs i bezpieczny kontrakt, ale domyślnie nie jest utrwalana.
