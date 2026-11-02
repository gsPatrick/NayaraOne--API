# ADR 0004 — K4 prefixo `GOV_`

## Contexto
A auditoria cega da parte 3 do bloco de governança apontou a contradição K4 (prefixo `GOV_`) entre o livro e/ou entre as demandas. Demandas afetadas: D800, D843 e todas com código.

## Decisão
Todo código criado pelos blocos E e F (HTTP, job, CI, bloqueio de migração, estado de tela) tem `GOV_`; 115 renomeações feitas. Exceção fechada de 6 códigos que já existem na plataforma: `PERMISSION_DENIED`, `MISSING_ACCESS_TOKEN`, `MFA_STEP_UP_REQUIRED`, `MFA_REQUIRED_NOT_ENABLED`, `INTERNAL_ERROR`, `VALIDATION_ERROR`; em 02/11/2026 entrou o sétimo, `ROUTE_NOT_FOUND` (404 de rota inexistente, DI-D843-8). Script `checkErrorCodes.js` reprova o resto

## Alternativas
Renomear os 6 códigos já existentes da plataforma com o prefixo `GOV_`. Rejeitada por padrão porque quebraria clientes atuais; a exceção é fechada, vem do parâmetro `governanca.erros.excecoes_prefixo_gov` e `checkErrorCodes.js` reprova o resto (decisão 2 da seção 8 da correção, aguardando confirmação do Patrick).

## Consequências
115 códigos renomeados para `GOV_`; o catálogo de erros (D843) e `npm run check:error-codes` reprovam o que sobrar.

## Data
2026-10-28

## Responsável
Patrick (dono do projeto), pela regra de que o livro manda e o que o livro não resolve vira decisão registrada.
