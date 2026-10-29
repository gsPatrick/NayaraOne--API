# Governança — Governança de API (`api-governance`)

## Objetivo
Governança de API: consumidores, contratos OpenAPI, mudança incompatível detectada, depreciação e catálogo de erros. Este módulo nasce no alicerce M9-D800 (esqueleto, permissões, liga/desliga e rota do livro); as regras entram em M9-D840 a M9-D844, e cada demanda dona atualiza este README no mesmo commit.

## Tabelas
Nenhuma ainda. O alicerce cria o schema `governance` e a função `governance.apply_tenant_rls(regclass)`, que toda tabela do módulo chama na sua migration (faixa 20260101000800 a 20260101000869 no bloco E) para ganhar RLS + FORCE RLS, política `tenant_isolation` e GRANT protegido por existência do role `nayara_runtime`. Colunas padrão: `id uuid`, `group_id`, `company_id`, `created_at`, `updated_at`.

## Rotas e permissões
- `GET /api-governance/consumers` exige `governance:api:read` e o módulo ligado para a empresa (esqueleto do alicerce: devolve o estado do módulo). Sem login: 401 `MISSING_ACCESS_TOKEN`; sem permissão: 403 `PERMISSION_DENIED`; módulo desligado: 403 `GOV_MODULE_DISABLED`.
- Corpo de erro único: `{success:false,error:{code,message,details?,traceId}}` (traceId dentro de `error`).

## Eventos
- `api.consumer.deprecation_due` (publicado pelo serviço do módulo via `publishGovernanceEvent`, na mesma transação, com `idempotencyKey`).

## Jobs e horários
Nenhum job no alicerce. Jobs deste módulo (se houver) são definidos pela demanda dona e listados aqui com horário e parâmetro que o controla.

## Parâmetros
- `governanca.modulos.api_governance.habilitado` (booleano, padrão ligado): o administrador liga ou desliga o módulo para a empresa em Configurações > Governança.
- Demais parâmetros do módulo: acrescentados pela demanda dona em `governance.settings.js` e em `SETTINGS_SCHEMA`, sempre com padrão do catálogo (`Maturacao/demandas/parametros.csv`).

## Decisões (ADR)
- K5: corpo de erro único com `error.traceId`; K4: código novo com prefixo `GOV_` (lista fechada de exceções configurável em `governanca.erros.excecoes_prefixo_gov`).
- Padrão do projeto de deixar o administrador decidir: tudo que é regra alternativa, limite, prazo, canal ou liga/desliga vira parâmetro, nunca valor fixo no código.
- Decisões de implementação do bloco: `Maturacao/demandas/decisoes-de-implementacao.md`.

## Como testar
`node scripts/withDisposableDb.js --port <porta> -- ...` com `test/m9d800.alicerceGovernanca.test.js` (alicerce) e os testes da demanda dona. Nunca contra o banco do `.env`.

## Como diagnosticar
Use o `traceId` da resposta de erro (igual ao cabeçalho `X-Correlation-Id`) para achar a requisição nos logs e no registro de auditoria. Módulo respondendo 403 `GOV_MODULE_DISABLED`: conferir a chave `governanca.modulos.api_governance.habilitado` em Configurações > Governança.

## Contrato OpenAPI versionado (M9-D840)
- Arquivo `openapi/openapi.v<MAJOR>.yaml` (OpenAPI 3.0.3, `info.version` SemVer) e escopo FECHADO em `openapi/escopo.json` (prefixos e rotas exatas; rota fora dele pode constar, não é exigida). `node scripts/gerarOpenapi.js --missing` mostra o que falta das rotas reais do escopo; o arquivo versionado é a fonte.
- `npm run lint:openapi -- --base <arquivo|ref git> --candidate openapi/openapi.v1.yaml [--scope] [--error-codes docs/ERROR_CODES.md] [--routes-file] [--json] [--report arquivo]`. Saída 0 ok; 1 `GOV_OPENAPI_BREAKING_CHANGE` ou `GOV_OPENAPI_ROUTE_UNDOCUMENTED`; 2 `GOV_OPENAPI_INVALID`. Não lê banco. No CI (`test.yml`): pull request compara com a branch de destino; push confere cobertura e validade.
- Código em `api-governance/openapi/`: `openapi.load.js` (leitura e validação), `diff.schema.js` (regras 2 a 7), `diff.operations.js` (regras 1 e 3), `diff.security.js` (8), `diff.errorCodes.js` (9, lê `x-error-code` das respostas e o catálogo `docs/ERROR_CODES.md`), `versions.js` (major nova exige a anterior com `info.x-deprecated: true` e `info.x-sunset`), `scope.js`, `skeleton.js`, `lint.service.js`.
- Convenções do contrato: `x-closed: true` num enum marca valor novo em resposta como breaking; `x-error-code` numa resposta fixa o código de erro estável da condição; `x-permissions` lista a permissão da rota.

## Padrões de API (M9-D843)
Código em `api-governance/standards/`; montado em `governance.module.js` (rotas de governança) e `src/routes/index.js` (limite, em toda a API).
- **Limite de requisições** (`rateLimit.*`): por credencial (`u:<empresa>:<usuário>`, `x:<hash da credencial externa>` ou `ip:<IP>`), contador em `governance.rate_limit_counters` (UNLOGGED, janela fixa de 60 s pelo relógio do banco, `INSERT ... ON CONFLICT DO UPDATE`), então N processos somam. Cabeçalhos `X-RateLimit-Limit/Remaining/Reset` em toda resposta; excesso: 429 `GOV_RATE_LIMITED` + `Retry-After`. Falha do contador deixa a requisição passar (log). Pula health/ping e `/public/share` (contador por IP da M9-D823). Na suíte (`NODE_ENV=test`) fica desligado, salvo `API_RATE_LIMIT_ENABLED=true`; `API_RATE_LIMIT_DISABLED=true` desliga no processo. Job `rateLimitCleanupJob` (janelas com mais de 10 min).
- **Paginação** (`pagination.helper.js`): `page` >= 1 e `pageSize` 1 a 200; `paginationGuard` recusa valor inválido (400 `GOV_VALIDATION_PAGINATION`, nunca corta) em toda rota de governança; `parsePagination`/`buildPagination`/`pageResult`/`pageOfArray` para as listas. TODA lista de governança (calendário, qualidade e domínios de dados, fila de merge, lotes em massa, operações manuais e reconciliações do BCP, modelos de formulário, políticas, anomalias e links do DLP) devolve `data` como lista e o bloco `pagination {page,pageSize,total,totalPages}` ao lado (`totalPages` = teto de total/pageSize); `limit`/`offset` próprios deixaram de valer. Tamanho padrão: `governanca.api.paginacao.tamanho_padrao` (50), ou o parâmetro de página do próprio módulo quando existe (calendário, qualidade, fila de merge, lotes e `governanca.bcp.listagem_limite`), sempre limitado a 200. Fora da regra: visões gerais (`itens` de módulo) e catálogos de código fixo (`/exports/catalog`).
- **Idempotência** (`idempotency.*`): `Idempotency-Key` (8 a 128) nas criações das rotas de governança, exigida nas quatro da lista fechada (`idempotency.routes.js`). A chave é reivindicada na transação do efeito (primeiro `req.withTenantTransaction`), a resposta é gravada logo antes de sair e devolvida com `Idempotent-Replay: true` até a validade; outro corpo: 422 `GOV_IDEMPOTENCY_KEY_REUSED`; repetição simultânea espera a primeira. `governance.idempotency_keys` (UNIQUE empresa+escopo+chave). Job `idempotencyCleanupJob`.
- **Catálogo de erros** (`errorCatalog.*`): `errorCatalog.data.json` é a fonte de `docs/ERROR_CODES.md` e de `governance.error_catalog` (sincronizada no boot). `node scripts/gerarErrorCatalog.js` atualiza a partir do código; `npm run check:error-codes` (CI) reprova código não catalogado, sem GOV_ fora da lista fechada, entrada incompleta ou documento velho. `errorHandler.js` anexa `error.traceId` (= `X-Correlation-Id`) em todo erro.
- Parâmetros: `governanca.api.rate_limit.{habilitado,interno_por_minuto,externo_por_minuto,anonimo_por_minuto}`, `governanca.api.paginacao.tamanho_padrao`, `governanca.api.idempotencia.{validade_horas,espera_segundos}`, `governanca.api.limpeza_job_minutos` (aba Governança).
