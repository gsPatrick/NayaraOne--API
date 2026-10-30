# ADR 0007 — K7 numeração dos formulários

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K7 (numeração dos formulários) entre o livro e/ou entre as demandas. Demandas afetadas: D830, D831, D834.

## Decisão
Único formato `<PREFIXO>-<AAAA>-<nnnnn>` com 6 prefixos do catálogo de setores (dono D830); `ATD-nnnn` e `OBR-REQ-nnnn` removidos; requisição de material é `form_type` dentro de OBR

## Alternativas
Manter dois formatos de numeração (`ATD-nnnn` e `OBR-REQ-nnnn` ao lado do formato por setor). Rejeitada: numeração em papel com formatos diferentes impede a conciliação.

## Consequências
Um único formato `<PREFIXO>-<AAAA>-<nnnnn>` com 6 prefixos do catálogo de setores (dono D830).

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
