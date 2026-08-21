# ADR 0008: Dwuetapowa bramka jakości narracji i guardowany baseline

- Status: zaakceptowane
- Data: 2026-08-16

## Kontekst

ADR 0007 zapewnił deterministyczny `GroundedOptionContext`, exact fact references, lokalną
walidację schematu i fazową granicę transakcji. Te mechanizmy dają traceability, ale nie
dowodzą, że wygenerowane zdanie rzeczywiście wynika z cytowanego faktu. Poprawny strukturalnie
tekst może nadal zmienić kwotę, datę, rolę rankingu lub provenance, wypełnić
`UNKNOWN`/`MISSING`, poluzować hard constraint, wykonać obliczenie albo zastosować instrukcję
ukrytą w danych providera.

Pełny grounded context zawiera także pola, których model nie potrzebuje, na przykład raw
`sourceUrl` i `externalItemId`. Sam prompt „traktuj dane jako nieufne” nie jest wystarczającą
granicą bezpieczeństwa. Jednocześnie publikacja musi zachować fail-closed audit z ADR 0006,
nie trzymać transakcji SQLite podczas żadnego provider call i nie utrwalać kandydata, raw
judge outputu ani swobodnego rationale po odrzuceniu.

Jakość musi być mierzalna przed rozszerzeniem AI lub podłączeniem prawdziwych danych.
Standardowa weryfikacja nie może jednak wykonywać sieci ani generować kosztu, a finalny live
baseline wymaga jawnej decyzji budżetowej i prywatnościowej.

## Decyzja

### Model-safe view i quality context

Kod buduje `narrative-model-view-v1` deterministycznie z dokładnego
`GroundedOptionContext`. Projection zachowuje `factId`, klucz, status, potrzebną wartość i
code-generated display, source freshness/timestamp, fixture version, `demonstrationData`
oraz deterministyczne lineage. Nie wysyła raw `sourceUrl`, `externalItemId`, control/bidi,
HTML ani innych provider-shaped wartości zbędnych do napisania tekstu. Dla provenance
model-facing `fact.key` jest wersjonowanym, nieodwracalnym opaque key wyprowadzonym wyłącznie
z bezpiecznego `factId`, nigdy z `provider`, `sourceKey`, `externalItemId`, `sourceUrl` lub
`contexts`. Pełny grounded key pozostaje lokalny dla lineage i frozen datasetu.

Model view zawiera fingerprint pełnego grounded context i własny canonical SHA-256.
`GENERATE` i `JUDGE` używają projection, natomiast pełny kontekst pozostaje lokalny dla
referential integrity, excluded-value detection i persistence. Oba kontrakty są
size-limited i immutable po walidacji.

Po lokalnej walidacji kandydata kod buduje osobny `narrative-quality-context-v1`. Zawiera
exact validated `OptionNarrativeOutput` i jego fingerprint, exact model/grounded
fingerprints, potwierdzone strukturalne constraints potrzebne do wykrycia ich relaksacji
oraz wersje context/prompt/schema/rubric/dataset/policy/profile/price contracts. Nie mutuje
kontraktu 3B2 i nie zawiera swobodnego tekstu użytkownika.

### Dwuetapowa bramka: precheck i strict JUDGE

Po `GENERATE`, lecz przed `JUDGE`, działa deterministyczny precheck. Jego zadaniem są wąskie,
mechanicznie rozpoznawalne przypadki formatowe i bezpieczeństwa: URL/Markdown, HTML,
script/event handlers, control/bidi, reprodukcja wykluczonych wartości oraz niedozwolony
format pieniędzy. Precheck reject wykonuje zero `JUDGE` calls.

Frozen dataset rozstrzyga ważną granicę tej odpowiedzialności. Przypadki R09 i R20 mają
`expected.stage = PRECHECK`, natomiast semantycznie zła lub nowa kwota, nowe obliczenie i
wypełnienie `UNKNOWN` w R07, R08 i R10 mają `expected.stage = JUDGE`; R07 i R10 należą także
do stability subset. Dlatego precheck pozostaje format/safety-only. Nie może przejąć
semantic amount comparison, wykrywania nowego obliczenia ani unknown filling od `JUDGE`.

Jest to świadoma interpretacja węższego boundary. Zbyt szerokie literalne odczytanie bulletu
„money-like strings inne niż exact display” z kontraktu 3B3 przechwyciłoby R07/R08/R10
przed `JUDGE` i kolidowałoby z zamrożonymi stage labels. Goldenów nie zmieniamy. Review musi
potwierdzić tę granicę i zachować regression tests dla sentinel R07/R10; do tego czasu jest
to jawne ryzyko, a nie ukryta zmiana kontraktu.

Po prechecku gateway wykonuje dokładnie jeden primary `JUDGE` przez profil zadania.
Wejście zawiera pełny, typowany kontrakt rubryki zgodny z checked-in golden JSON: exact
version i canonical fingerprint, wszystkie osiem definicji, semantykę `PASS`/`FAIL`, pełny
katalog reason codes oraz mapy reason → dimensions/severity. Zawiera też exact
`qualityContextFingerprint` i `narrativeFingerprint`; sama nazwa wersji nie wystarcza.
Wersjonowany strict output musi echo exact quality/narrative fingerprints i zwrócić każdy z
ośmiu wymiarów dokładnie raz jako `PASS` lub `FAIL`. Findings używają wyłącznie zamkniętych
reason codes, `MAJOR`/`CRITICAL`, istniejących block sequences i exact in-context fact IDs.
Niepełna/zmieniona rubryka, unknown fields, dimensions, codes, severity, blocks, facts,
fingerprint mismatch albo niespójność finding/dimension odrzucają cały output.

Model nie zwraca wiążącego overall verdict, tekstowej naprawy ani persistowalnego rationale.
Kod jest jedynym właścicielem decyzji: osiem `PASS` i zero findings daje `PUBLISH`; dowolny
`FAIL` albo finding daje `REJECT`. Nie ma `REVIEW` jako stanu publikacji, drugiego judge,
quorum, semantic retry, rewrite, regeneration lub provider/model fallback.

### Audit, review persistence i transakcje

Use case zachowuje granicę:

`short product read → GENERATE audit/provider/audit → local precheck → JUDGE
audit/provider/audit → short product/review write`.

Żadna transakcja DB nie pozostaje aktywna podczas provider call. Każdy task wymaga durable
`STARTED` przed adapterem i durable terminalnego audytu przed użyciem outputu. `AiRuns`
otrzymuje addytywne, nullable/no-default metadata configured effort oraz configured/effective
output-token limit. Legacy rows pozostają `null`; nowe runy populują pola przed call.

Próba, która nie osiąga durable `STARTED`, nie ma prawdziwego `AiRunId`, nie tworzy
`NarrativeReviewRun` i nie może otrzymać fikcyjnego UUID. Provider nie jest wywoływany,
candidate/produkt nie są zapisywane, a osobny wstrzykiwalny operational sink otrzymuje
dokładnie jedną próbę allowlistowanego `AI_PRE_START_FAILURE` z
`providerCallAttempted=false`. Sygnał nie zawiera promptu, inputu, candidate, outputu, raw
błędu/cause/stack, PII, sekretu ani `aiRunId`. Dla pre-`STARTED` `JUDGE` istniejący prawdziwy
audit `GENERATE` pozostaje, ale review ani produkt nie powstają.

Wewnętrzne `NarrativeReviewRuns` i znormalizowane `NarrativeReviewFindings` zapisują wyłącznie
planning/option linkage, scalar IDs audytów, fingerprints, wersje, stage, code-owned
decision, osiem wyników wymiarów, kontrolowane codes/severity, counts i timestamps. Nie
zapisują promptu, kontekstu, candidate text, raw judge output, rationale, raw error,
source URL/external ID, PII, sekretu ani credentiala. Review i `AiRuns` nie są publikowane
przez OData.

`rubricFingerprint` jest addytywnym nullable polem bezpiecznych review/product metadata.
Nowe rekordy 3B3 zapisują exact canonical fingerprint; legacy rows pozostają `null` i nie są
backfillowane.

Precheck lub semantic reject zapisuje safe review metadata w osobnej krótkiej transakcji, a
następnie zwraca kontrolowany `NARRATIVE_QUALITY_REJECTED`. Powstaje zero `NarrativeRuns`,
`OptionNarratives` i `NarrativeFactReferences`. Awaria techniczna również nie może
opublikować tekstu.

Dla `PUBLISH` jedna krótka transakcja atomowo zapisuje review i dokładny byte-for-byte tekst
oceniony przez judge dopiero po walidacji exact terminalnych `SUCCEEDED` obu audytów,
planning linkage i fingerprints. Nowy `NarrativeRuns` zachowuje scalar review/judge links i
quality versions. Addytywne pola legacy 3B2 są nullable bez defaultu; stary rekord nie jest
backfillowany ani traktowany jako zaakceptowany przez 3B3.

Cleanup efemerycznego `AiRun` nie ma foreign key do produktu. Usunięcie generate lub judge
audytu nie usuwa durable review ani zaakceptowanej narracji.

### Offline contract replay, live guard i baseline

`narrative-quality-v1` jest frozen synthetic golden setem: 32 semantic cases — 12
`PUBLISH`, 20 `REJECT`, w tym 18 critical — oraz cztery synthetic end-to-end contexts.
Loader waliduje machine-readable schema, exact counts, stable fact keys, labels,
critical/sentinel membership, reason codes, dimensions i canonical fingerprint. Przed
replayem standardowy `verify` wykonuje `eval:schema:check`: generuje schema z runtime Zod,
normalizuje wyłącznie kontrolowane elementy techniczne i porównuje canonical form/fingerprint
z frozen checked-in JSON Schema. Golden nie jest automatycznie aktualizowany.

Offline harness wykonuje deterministic contract replay przez produkcyjne buildery i
adaptery in-memory. Kopiuje frozen expected labels do actual, dlatego wynik ma
`evidenceKind=CONTRACT_REPLAY` oraz `modelQualityMeasured=false`: jest dowodem integralności
loadera, resolverów, kontraktów, metryk, gates i report path, nie pomiarem jakości modelu.

Live E2E wykonuje ponadto zamknięty, wersjonowany katalog deterministic
`requiredProperties` na exact candidate/context/model view/constraints. Evaluatory nie
korzystają z overall decision, dimensions, findings ani reason codes `JUDGE`; naruszenie
przegrywa gate nawet przy ośmiu `PASS` i zero findings. Privacy-safe raport zawiera tylko
property ID, wynik i kontrolowany failure code. In-memory
`publicationBundleLinkageValidInMemory` dowodzi konstrukcji bundle, nie DB persistence.
Osobny test integracyjny zapisuje exact synthetic E2E bundle produkcyjnym writerem CAP/SQLite
i odczytuje exact lineage/fingerprint/bloki/references, atomowość oraz stan po cleanup obu
`AiRuns`.

Raport zawiera wyłącznie safe IDs, expected/actual labels/codes, wersje, configured/response
models, usage, latency, attempts, refusal i integer-only estimated cost. Nie zawiera raw
promptu, kontekstu, narracji ani payloadu providera. Baseline manifest wiąże exact report,
dataset fingerprint, wszystkie wersje i oba profile bez alias substitution.

Finalny live baseline jest osobną, domyślnie wyłączoną ścieżką. Wymaga jednocześnie:

- `AI_LIVE_EVAL_ENABLED=true` i istniejącego opt-in gatewaya;
- credentiali skonfigurowanych poza repo;
- wersjonowanej ceny każdego dokładnego configured modelu;
- `AI_MAX_RETRIES=0`, dopóki thrown failure nie niesie bezpiecznego attempts/usage settlement;
- osobnej zgody na dokładny call plan i konserwatywny koszt;
- maksymalnie 48 logical calls, 56 provider attempts i USD 3.00.

Preflight blokuje unknown pricing lub przekroczenie cap przed pierwszym call. Sequential
guard rezerwuje worst-case attempts i koszt przed każdym kolejnym call i fail-closed blokuje
operację, która mogłaby przekroczyć limit. Runner v1 planuje dokładnie 46 calls. Checked-in
katalog zawiera oficjalne stawki API zweryfikowane 2026-08-21, a osobna czysta komenda
cost-preflight używa tego samego planera bez opt-inów, credentiali, executora lub sieci.
Aktualny profil Terra przekracza cap USD 3; porównawczy Luna mieści się w cap, ale nie zmienia
to profilu runtime i wymaga osobnej decyzji człowieka. CI, test, build, startup i postinstall
nie mogą włączyć live eval.

Podczas implementacji nie wykonano żadnego live ani paid call; rzeczywisty koszt wynosi USD 0. Finalny baseline wymaga osobnej zgody i nie został uruchomiony. Z tego powodu Faza 3B3
pozostaje w statusie `REVIEW`, nawet po zielonej weryfikacji offline, i nie może zostać
oznaczona `DONE`.

## Konsekwencje

Publikowana narracja ma minimalne wejście modelu, exact lineage, lokalny format/safety gate,
niezależną ocenę semantyczną oraz decyzję należącą wyłącznie do kodu. Reject pozostawia
audytowalny, privacy-safe ślad bez tekstu, a cleanup efemerycznych audytów nie uszkadza
produktu. Rozdzielenie transakcji zachowuje fail-closed recorder i eliminuje SQLite circular
wait podczas obu provider calls.

Kosztem są dwa provider calls dla zaakceptowanego kandydata, więcej wersjonowanych
kontraktów i persistence metadata oraz konieczność utrzymywania golden setu i baseline dla
dokładnych profili. Wąski precheck celowo nie próbuje rozstrzygać semantycznych money/unknown
przypadków; jakość tej warstwy zależy od strict `JUDGE` i mierzalnych release gates.

Akcja nadal pozostaje ręczna i opt-in, bez UI, automatycznego `startPlanning`, real travel
providers, live availability, itinerary, fallbacku i publicznego enablementu. Kolejna faza
nie może traktować statusu `REVIEW` ani samego zielonego offline CI jako zaakceptowanego live
baseline.
