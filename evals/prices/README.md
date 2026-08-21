# Narrative quality price catalog v1

Ten katalog jest wersjonowanym snapshotem oficjalnych cen API używanym do
deterministycznego, konserwatywnego szacowania maksymalnego kosztu live evaluation.
Ceny zweryfikowano 2026-08-21. Wszystkie wartości w pliku JSON są integerami USD
micros za 1 000 000 tokenów; 1 USD odpowiada 1 000 000 USD micros.

Stawki dotyczą rozliczanego tokenowo użycia bezpośrednich API OpenAI i Anthropic.
Nie są cenami subskrypcji ChatGPT ani planów Claude Free, Pro, Max, Team lub
Enterprise. Nie uwzględniają indywidualnych rabatów, umów enterprise ani cen
platform partnerskich.

## Zakres snapshotu

Snapshot zakłada:

- standardowe przetwarzanie, a nie Batch, Flex ani Fast mode;
- globalną lokalizację inferencji bez dopłaty za data residency;
- bezpośrednie API providerów, a nie Amazon Bedrock, Google Cloud lub Microsoft
  Foundry;
- short context dla modeli OpenAI.

W przypadku OpenAI request przekraczający 272 000 input tokens jest rozliczany
według wyższych stawek long-context dla całego requestu. Dla GPT-5.6 Terra są to
odpowiednio 4 000 000 input, 400 000 cached input, 5 000 000 cache write i
18 000 000 output USD micros/MTok. Dla GPT-5.6 Luna są to 400 000, 40 000,
500 000 i 1 800 000 USD micros/MTok. Ten katalog nie może być użyty do takiego
requestu.

OpenAI Fast mode może zostać włączony parametrem requestu albo ustawieniem
projektu i ma inne, wyższe stawki. Regional processing kwalifikujących się modeli
OpenAI ma dopłatę 10%. Użycie którejkolwiek z tych opcji wymaga innego snapshotu
cenowego.

Anthropic używa globalnej inferencji domyślnie. Dla Claude 4.6 i nowszych
inference_geo ustawione na us zwiększa wszystkie klasy cenowe o 10%. Claude
Sonnet 5 zachowuje standardowe stawki w całym oknie kontekstowym 1M tokenów.

## Claude Sonnet 5

Anthropic początkowo ogłosił 2 USD/MTok input i 10 USD/MTok output jako cenę
promocyjną do 2026-08-31. W aktualizacji z 2026-08-10 firma uczyniła tę cenę
permanentną i anulowała planowaną podwyżkę do 3 USD/MTok input oraz 15 USD/MTok
output od 2026-09-01.
Przy rozbieżności z nadal niezsynchronizowanymi stronami pricing docs rozstrzygającym
źródłem jest późniejszy changelog Anthropic z 2026-08-10.

Z tego powodu snapshot nie zawiera pricingValidThrough i nie ma guardu
wygasającego 2026-08-31. Każda przyszła zmiana oficjalnej ceny nadal wymaga
jawnej rewalidacji i nowej wersji katalogu.

## Cache i reasoning

Dla Claude Sonnet 5 cache read kosztuje 0,1 stawki input, a standardowy
5-minutowy cache write kosztuje 1,25 stawki input. Pole cache write w katalogu
reprezentuje właśnie zapis 5-minutowy. Zapis godzinny kosztuje 2 razy stawkę
input i nie jest reprezentowany przez obecny pojedynczy field. Aktualny adapter
nie ustawia cache_control, ale katalog przechowuje pełne oficjalne klasy cenowe.

Dokumentacja Anthropic raportuje thinking tokens jako podzbiór rozliczanych
output tokens. Dokumentacja OpenAI raportuje reasoning tokens w
output_tokens_details jako podzbiór output_tokens, a limit max_output_tokens
obejmuje zarówno widoczny output, jak i reasoning. Dlatego stawka reasoning jest
równa stawce output. Są to rozłączne klasy w lokalnej kalkulacji kosztu, aby nie
naliczać reasoning drugi raz.

## Oficjalne źródła

Źródła zweryfikowano 2026-08-21:

- Anthropic API pricing:
  https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic prompt caching:
  https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic extended thinking:
  https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Anthropic Sonnet 5 announcement and 2026-08-10 pricing update:
  https://www.anthropic.com/research/claude-sonnet-5
- OpenAI API pricing:
  https://developers.openai.com/api/docs/pricing
- OpenAI GPT-5.6 Terra:
  https://developers.openai.com/api/docs/models/gpt-5.6-terra
- OpenAI GPT-5.6 Luna:
  https://developers.openai.com/api/docs/models/gpt-5.6-luna
- OpenAI Responses API reference:
  https://developers.openai.com/api/reference/resources/responses/methods/create
- OpenAI Fast mode:
  https://developers.openai.com/api/docs/guides/fast-mode

## Wersja katalogu

Plik narrative-quality-price-catalog-v1.json był pustym placeholderem i nie
stanowił jeszcze zaakceptowanego baseline. Jego pierwsze uzupełnienie oficjalnymi
stawkami oraz datą weryfikacji pozostaje pierwszą wersją katalogu, dlatego
priceCatalogVersion nadal ma wartość narrative-quality-price-catalog-v1.
Po wykorzystaniu tego snapshotu do baseline nie należy zmieniać jego stawek;
zmiana cen lub zakresu rozliczeń wymaga kolejnej wersji katalogu.
