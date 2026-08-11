# Provider adapters

Interfejsy transportu, noclegów i miejsc izolują domenę od formatu konkretnego API.
Faza 2B dostarcza stabilne implementacje fixture, które działają bez internetu i
generują dane względem dat jawnego requestu. Każdy poprawny fakt i każda cena mają
`SourceSnapshot`; celowo niepoprawne rekordy służą testom filtrów. Orkiestracja waliduje
brief przed fan-outem, a mock adaptery dodatkowo odrzucają niepoprawny request na swojej
publicznej granicy.
