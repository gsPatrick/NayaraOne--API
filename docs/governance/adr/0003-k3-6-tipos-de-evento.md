# ADR 0003 — K3 "6 tipos de evento"

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K3 ("6 tipos de evento") entre o livro e/ou entre as demandas. Demandas afetadas: D800 (e teste 6).

## Decisão
São 7 do livro (`recorded` e `imported` contam dois). D800 §5 lista os 7 mais os complementares com a demanda que publica cada um

## Alternativas
Manter "6 tipos de evento". Rejeitada: o livro lista 7 (`recorded` e `imported` contam dois); o catálogo fechado segue a lista real.

## Consequências
`governance.events.js` guarda o catálogo fechado de 7 eventos e as demandas donas publicam os complementares.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
