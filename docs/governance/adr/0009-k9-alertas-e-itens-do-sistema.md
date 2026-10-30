# ADR 0009 — K9 alertas e itens do sistema

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K9 (alertas e itens do sistema) entre o livro e/ou entre as demandas. Demandas afetadas: D801, D802, D830, D832, D841, D851, D871, D872.

## Decisão
Alertas do calendário leem só `calendar_items`. Itens gerados pelo sistema ganham origem própria `SYSTEM_TASK` (`calendar_system_items`, 7 kinds), 11ª fonte além das 10 do livro; `COMMITMENT` fica só para compromisso de pessoa

## Alternativas
Tratar pendências do sistema como compromissos (`COMMITMENT`). Rejeitada: misturaria compromisso de pessoa com tarefa gerada; `SYSTEM_TASK` é a 11ª origem, ao lado das 10 do livro.

## Consequências
Os alertas leem só `calendar_items`; `calendar_system_items` tem 7 kinds.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
