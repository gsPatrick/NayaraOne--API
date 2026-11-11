# Deploy do fechamento do Marco 5 — migrations depois da 9964 e a API do Marco 5

As migrations do fechamento do Marco 5 (`20260101009981` a `20260101009999`, todas depois da `20260101009964` do Marco 9) renomeiam tabelas para os nomes do caderno (§4) e acrescentam colunas e tabelas que a API do Marco 5 usa:

| Antes | Depois | Migration |
|---|---|---|
| `legal.contract_clauses` | `legal.clause_versions` (+ nova `legal.clause_library`) | `20260101009983` |
| `legal.contract_amendments` | `legal.addenda` (+ nova `legal.addendum_signatures`) | `20260101009986` |
| `finance.utility_obligations` | `legal.lease_obligations` (`finance.utility_obligations` continua como visão gravável) | `20260101009992` |
| `legal.legal_case_parties` | `legal.case_parties` | `20260101009996` |

Tabelas novas: `legal.template_versions` (9982), `legal.inspection_media` (9991), `legal.notice_versions` e `legal.case_receivables` (9998). A prova de que os renomes preservam a tabela (mesmo OID, linhas, RLS, policies, GRANTs, índices e FKs no `down` e no `up`) é `scripts/ci-juridico/renomes-livro.js` (etapa `migrations` da esteira do jurídico).

A API anterior (Marco 9 sem o Marco 5) NÃO funciona depois dessas migrations (nomes de tabela novos). Por isso elas sobem junto com a API do Marco 5, numa janela com a API parada.

## Ordem

1. Plano do Marco 9 já aplicado (até a `20260101009964`, `docs/DEPLOY_MARCO_9.md`).
2. Backup novo imediatamente antes (`pg_dump -Fc`, com SHA-256).
3. Parar a API.
4. Aplicar as migrations do fechamento do Marco 5 (`npx sequelize-cli db:migrate --env migration`).
5. Deploy da API e do Front do Marco 5; conferir `/api/health` e `/api/version`.
6. Fumaça: criar contrato, aprovar a versão, listar prazos de um processo, abrir uma vistoria.

## Plano de reversão

`npx sequelize-cli db:migrate:undo:all --to 20260101009981-legal-aprovacao-por-versao-e-arquivo-da-versao.js --env migration` devolve os nomes antigos (mesma tabela, mesmos dados) e remove só objetos novos; então reimplantar a API anterior. Se alguma `down` falhar, restaurar o backup.
