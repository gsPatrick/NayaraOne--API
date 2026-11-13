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

## Depois da M4-D140 (migrations do Financeiro na pasta do módulo)

Os comandos acima não mudam. Desde a M4-D140, as migrations que mexem no schema `finance` (entre elas `20260101009984`, `20260101009985` e `20260101009992`, que fazem parte deste intervalo) ficam em `src/modules/finance/infrastructure/db/migrations/`, com o mesmo nome; o `.sequelizerc` faz o `sequelize-cli` ler as duas pastas na ordem global do nome, então `db:migrate` e `db:migrate:undo:all --to ...` aplicam e desfazem as mesmas migrations, na mesma ordem. Detalhes em `docs/DEPLOY_ESTRUTURA_FINANCEIRO_M4D140.md`.

## Esteira do jurídico e portão de produção (M5ES, 11/11/2026)

Sem migration nova. A esteira (`.github/workflows/juridico-esteira.yml`, `scripts/ci-estagios-juridico.sh`) roda as 18 etapas do Guia §17 na ordem do livro, num único processo, em todo push e pull request: `deploy_DEV` e `deploy_LAB` publicam o artefato do commit (git archive + `VERSION`, como o Dockerfile) no próprio job e fazem o smoke do jurídico (`scripts/ci-juridico/deployLocal.js`); `failure_drills` inclui o drill de restore completo (`scripts/restoreDrill/legalFullDrill.js`); `production_approval` é o portão (`scripts/ci-juridico/gateProducao.js`), que bloqueia sem restore verde, sem pentest verde, com falha aberta (teste falho, pulado ou `todo`) ou com etapa anterior não verde no mesmo commit.

O que só roda no ambiente do Patrick (configuração do GitHub, uma vez):

1. Environment `lab` com os secrets `DEV_API_DEPLOY_HOOK_URL`, `DEV_API_URL`, `LAB_API_DEPLOY_HOOK_URL` e `LAB_API_URL` (hook de deploy e URL pública de cada ambiente). Sem eles, a esteira de release fica vermelha em `deploy_DEV` (nunca finge que publicou).
2. Environment `juridico-aprovacao` com revisor obrigatório (o Patrick).
3. Release: criar a tag `jur-release-<data>` no commit. O job `esteira-juridico-release` roda as 18 etapas com `--release` (o hook publica no DEV e no LAB e confere o commit em `/api/version`); o job `aprovacao-producao` confere de novo o portão sobre as evidências arquivadas e espera a aprovação. O CI não publica em produção: depois da aprovação, o deploy de produção segue a seção "Ordem" acima.
