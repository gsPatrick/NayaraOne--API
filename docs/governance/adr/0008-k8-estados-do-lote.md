# ADR 0008 — K8 estados do lote

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K8 (estados do lote) entre o livro e/ou entre as demandas. Demandas afetadas: D900, D901, D905.

## Decisão
Lista única em D900 §3.4: PLANNED, RUNNING, APPLIED, VERIFIED, HASH_MISMATCH, FAILED, ABORTED com transições; D901 e D905 alinhados

## Alternativas
Cada demanda de migração com a sua lista de estados do lote. Rejeitada: listas diferentes geram transições impossíveis de conferir; a lista única fica em D900 §3.4.

## Consequências
D900, D901 e D905 compartilham a lista PLANNED, RUNNING, APPLIED, VERIFIED, HASH_MISMATCH, FAILED, ABORTED.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
