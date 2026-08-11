# Zakres MVP

## P0

- europejski city break rozpoczynający się w mieście użytkownika;
- zebranie i potwierdzenie podstawowego briefu;
- przyszłe adaptery danych transportu i noclegów;
- deterministyczne filtry wykonalności i kalkulacja kosztów;
- trzy zróżnicowane warianty z kompromisami i źródłami;
- szczegółowy plan dopiero po wyborze wariantu.

## Stan realizacji

Faza 2A — Domain and Workflow Core — jest zakończona. Obejmuje:

- zachowanie CRUD `TripRequest`, obecnego formularza i akcji `confirmConstraints`;
- jawne, strukturalne profile hard constraints i soft preferences z wartościami domyślnymi;
- deterministyczną walidację briefu, ograniczeń i wag preferencji;
- osobny `WorkflowRun` oraz rozdzielenie statusu briefu od stanu workflow;
- czystą maszynę stanów i walidację dozwolonych przejść;
- transakcyjne potwierdzenie constraints i synchronizację statusu briefu ze stanem workflow.

Ukończenie Fazy 2A nie oznacza ukończenia całej Fazy 2. Stany późniejszych etapów są obecnie wyłącznie kontraktem domenowym; aplikacja ich jeszcze nie wykonuje.

Faza 2B — Mock Providers and Deterministic Candidate Engine — dodaje:

- typowane kontrakty transportu, noclegów i miejsc niezależne od zewnętrznych API;
- wersjonowane, stabilne fixture providery działające bez internetu;
- `Money` w minor units, jawne typy cen i źródła `SourceSnapshot`;
- ograniczony candidate builder, pełny budżet i deterministyczne filtry wykonalności;
- wersjonowany scoring w kodzie oraz wybór ról `BEST_OVERALL`, `MOST_CONVENIENT` i
  `BEST_VALUE` bez automatycznego luzowania constraints.

Ukończenie Fazy 2B nadal nie oznacza ukończenia całej Fazy 2. Silnik nie jest jeszcze
wywoływany z UI ani endpointu CAP i nie utrwala wynikowych wariantów.

## Poza zakresem Faz 2A–2B

- endpoint uruchamiający planowanie oraz persystencja kandydatów;
- prawdziwi providerzy, live search i API podróżne;
- ekran wariantów;
- modele LLM, prompty produkcyjne i generowanie przez AI;
- szczegółowy plan dzień po dniu.

## Poza MVP

Podróże wieloetapowe, loty międzykontynentalne, rezerwacje, płatności, współdzielenie planów, uwierzytelnianie, aplikacje mobilne i automatyczne zmiany ograniczeń pozostają poza zakresem.
