# ADR 0011 — K11 aprovação de flag CRITICAL

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K11 (aprovação de flag CRITICAL) entre o livro e/ou entre as demandas. Demandas afetadas: D870, D872, D904.

## Decisão
Regra única em D870: MFA do solicitante e segundo aprovador. Exceções só para a direção segura: acionar kill switch (uma pessoa com MFA) e rollback de setor. Restaurar kill switch e avançar canary exigem segundo aprovador (no canary, o A da RACI)

## Alternativas
Só MFA, ou só segundo aprovador, para toda mudança de flag CRITICAL. Rejeitada: acionar kill switch precisa ser rápido e seguro (uma pessoa com MFA). Revisão posterior, registrada em M9-D872: acionar não exige MFA e restaurar exige MFA, motivo e auditoria, sem segundo aprovador.

## Consequências
Uma regra única em D870 com exceções só na direção segura.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
