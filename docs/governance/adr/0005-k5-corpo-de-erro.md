# ADR 0005 — K5 corpo de erro

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K5 (corpo de erro) entre o livro e/ou entre as demandas. Demandas afetadas: D800, D842, D843, D852.

## Decisão
Único: `{success:false,error:{code,message,details?,traceId}}`, `traceId` dentro de `error`, igual ao `X-Correlation-Id`

## Alternativas
`traceId` na raiz do corpo de erro. Rejeitada: um formato único com o `traceId` dentro de `error` serve ao contract test e ao catálogo.

## Consequências
Todas as rotas do bloco usam o corpo único; o contract test (D842) confere `traceId` igual a `X-Correlation-Id`.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
