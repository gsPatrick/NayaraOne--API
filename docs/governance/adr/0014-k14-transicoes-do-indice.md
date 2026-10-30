# ADR 0014 — K14 transições do índice

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K14 (transições do índice) entre o livro e/ou entre as demandas. Demandas afetadas: D930, D931.

## Decisão
Acrescentados `CURRENT -> REFERENCE` e `REFERENCE -> SUPERSEDED`

## Alternativas
Manter só as transições originais do índice documental. Rejeitada: sem `CURRENT -> REFERENCE` e `REFERENCE -> SUPERSEDED` não há como aposentar um documento sem apagar.

## Consequências
A máquina de estados do índice ganhou duas transições.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
