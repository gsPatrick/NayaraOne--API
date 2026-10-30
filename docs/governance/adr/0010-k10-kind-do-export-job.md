# ADR 0010 — K10 `kind` do export_job

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K10 (`kind` do export_job) entre o livro e/ou entre as demandas. Demandas afetadas: D821, D920, D915.

## Decisão
Coluna `kind` (EXPORT, SHARE, PRINT, DOWNLOAD, AI) em D821

## Alternativas
Deduzir a natureza da saída pela rota de origem. Rejeitada: a coluna `kind` explícita no `export_job` permite política, auditoria e relatórios por natureza.

## Consequências
`export_jobs.kind` aceita EXPORT, SHARE, PRINT, DOWNLOAD e AI.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
