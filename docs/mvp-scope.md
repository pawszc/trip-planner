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

## Poza zakresem Fazy 2A

- mock providerzy oraz prawdziwi providerzy i API podróżne;
- wyszukiwanie transportu i noclegów;
- candidate builder i walidacja kandydatur pochodzących z wyszukiwania;
- ranking i wybór trzech wariantów;
- ekran wariantów;
- modele LLM, prompty produkcyjne i generowanie przez AI;
- szczegółowy plan dzień po dniu.

## Poza MVP

Podróże wieloetapowe, loty międzykontynentalne, rezerwacje, płatności, współdzielenie planów, uwierzytelnianie, aplikacje mobilne i automatyczne zmiany ograniczeń pozostają poza zakresem.
