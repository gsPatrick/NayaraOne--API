# Governança — Governança de API (`api-governance`)

## Objetivo
Governança de API: consumidores, contratos OpenAPI, mudança incompatível detectada, depreciação e catálogo de erros. Este módulo nasce no alicerce M9-D800 (esqueleto, permissões, liga/desliga e rota do livro); as regras entram em M9-D840 a M9-D844, e cada demanda dona atualiza este README no mesmo commit.

## Tabelas
`governance.api_consumers`, `governance.api_consumer_usage` e `governance.api_deprecations` (M9-D841, migrations 841 a 844; RLS + FORCE). O alicerce cria o schema `governance` e a função `governance.apply_tenant_rls(regclass)`, que toda tabela do módulo chama na sua migration (faixa 20260101000800 a 20260101000869 no bloco E) para ganhar RLS + FORCE RLS, política `tenant_isolation` e GRANT protegido por existência do role `nayara_runtime`. Colunas padrão: `id uuid`, `group_id`, `company_id`, `created_at`, `updated_at`.

## Rotas e permissões
- `GET /api-governance/consumers` (`governance:api:read`), `GET|POST /api-governance/deprecations` e `POST /api-governance/deprecations/:id/cancel` (escrita: `governance:api:manage`) exigem o módulo ligado para a empresa (detalhes em "Consumidores e deprecação"). Sem login: 401 `MISSING_ACCESS_TOKEN`; sem permissão: 403 `PERMISSION_DENIED`; módulo desligado: 403 `GOV_MODULE_DISABLED`.
- Corpo de erro único: `{success:false,error:{code,message,details?,traceId}}` (traceId dentro de `error`).

## Eventos
- `api.consumer.deprecation_due` (publicado pelo serviço do módulo via `publishGovernanceEvent`, na mesma transação, com `idempotencyKey`).

## Jobs e horários
`apiDeprecationJob` (M9-D841): diário às 07:00 America/Sao_Paulo (`governanca.api.deprecacao.job_hora`). Os demais jobs do módulo estão na seção de padrões de API. Jobs deste módulo (se houver) são definidos pela demanda dona e listados aqui com horário e parâmetro que o controla.

## Parâmetros
- `governanca.modulos.api_governance.habilitado` (booleano, padrão ligado): o administrador liga ou desliga o módulo para a empresa em Configurações > Governança.
- Demais parâmetros do módulo: acrescentados pela demanda dona em `governance.settings.js` e em `SETTINGS_SCHEMA`, sempre com padrão do catálogo (`Maturacao/demandas/parametros.csv`).

### Demais parâmetros do módulo (M9-D891: conferência)
Todo parâmetro `governanca.*` lido pelo módulo consta neste README; o valor muda em /painel/configuracoes (aba Governança) e vale na leitura seguinte.

| Chave | Padrão | O que controla |
|---|---|---|
| `governanca.api.rate_limit.anonimo_por_minuto` | `60` | acessos por minuto, por IP, nas rotas sem login (M9-D843 §3.1; aqui o consumidor é /public/share/:token). |
| `governanca.api.rate_limit.habilitado` | `true` | liga o limite de requisições (padrão ligado). |
| `governanca.api.rate_limit.interno_por_minuto` | `1200` | requisições por minuto por usuário logado (padrão 1200; o tráfego manual é o dobro do automatizado). |
| `governanca.api.rate_limit.externo_por_minuto` | `600` | requisições por minuto por credencial de API externa (padrão 600). |
| `governanca.api.idempotencia.validade_horas` | `24` | por quanto tempo a chave devolve a resposta original (padrão 24). |
| `governanca.api.idempotencia.espera_segundos` | `10` | quanto uma repetição simultânea espera a resposta da primeira antes de responder 409 (padrão 10). |
| `governanca.api.deprecacao.consumidor_ativo_dias` | `30` | janela em que o consumidor conta como "usando" um alvo (padrão 30). |
| `governanca.api.deprecacao.cache_segundos` | `30` | por quanto tempo cada processo guarda as deprecações e consumidores da empresa (padrão 30; 1 a 3600). |
| `governanca.api.consumidor.uso_intervalo_minutos` | `60` | no máximo uma gravação de uso por consumidor e alvo neste intervalo (padrão 60). |

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

## Consumidores e deprecação (M9-D841)
Código em `api-governance/consumers/`; o middleware `deprecationMiddleware` é montado em `src/routes/index.js` logo após o limite de requisições.
- **Catálogo** (`governance.api_consumers`): nome, tipo (`APP`, `PROVIDER`, `PARTNER`, `INTERNAL`), responsável obrigatório, e-mail de contato, major usada, `client_id` (credencial externa da M9-D844), `app_key`, `last_seen_at` e situação. Não há rota de cadastro: a M9-D844 chama `registerConsumer` no mesmo ato da credencial (só `PARTNER` ou `PROVIDER`); a migration 844 semeia o consumidor `APP` do front web (`app_key = nayara-web`) por empresa, e o middleware cria o da empresa nova na primeira chamada com o valor configurado em `governanca.api.consumidor.app_web_chave`.
- **Rastro de uso**: o front envia `X-Client-App`; credencial externa envia `X-Client-Id` (só em `/api-external`). Consumidor conhecido, em resposta < 400, grava `MAJOR:<n>` e `ROUTE:<MÉTODO> <caminho com {parâmetros}>` em `governance.api_consumer_usage`, no máximo uma vez por `uso_intervalo_minutos` por consumidor e alvo (travado no UPSERT, vale entre processos). Valor desconhecido não é rastreado.
- **Deprecação** (`governance.api_deprecations`): alvo `ROUTE:...` (caminho do contrato, sem `/api/v1`) ou `MAJOR:<n>`, `announced_at`, `sunset_at` (obrigatório e posterior), responsável (obrigatório), substituta (URL relativa) e situação `ANNOUNCED`, `SUNSET`, `CANCELLED`. Uma só em andamento por alvo.
- **Respostas**: rota deprecada leva `Deprecation: @<epoch>`, `Sunset: <data HTTP>` e `Link: <substituta>; rel="successor-version"`; vale o desligamento mais próximo entre rota e major. Depois de `sunset_at` responde 410 `GOV_API_VERSION_SUNSET` pelo relógio (as rotas `/api-governance` nunca são desligadas). A deprecação é da empresa: chamada sem credencial não recebe cabeçalho. Na suíte (`NODE_ENV=test`) o middleware fica desligado, salvo `API_DEPRECATION_ENABLED=true`; `API_DEPRECATION_DISABLED=true` desliga no processo.
- **Evento**: o job avalia cada deprecação `ANNOUNCED`; vencida vira `SUNSET`; a `governanca.api.aviso_dias` dias (padrão 30) ou menos publica `api.consumer.deprecation_due` (`{consumerId, target, sunsetAt, daysLeft}`, chave `api.consumer.deprecation_due:<consumerId>:<target>`) por consumidor ativo que usou o alvo nos últimos `consumidor_ativo_dias`, e avisa (IN_APP) o responsável do consumidor e o da deprecação, tudo na mesma transação.
- **Parâmetros** (aba Governança): `governanca.api.aviso_dias`, `governanca.api.deprecacao.{consumidor_ativo_dias,job_hora,cache_segundos}`, `governanca.api.consumidor.{uso_intervalo_minutos,app_web_chave}`.
- **Erros**: 422 `GOV_API_OWNER_REQUIRED`, `GOV_API_SUNSET_REQUIRED`, `GOV_API_DEPRECATION_INVALID`, `GOV_API_DATE_INVALID`, `GOV_API_OWNER_INVALID`, `GOV_API_TARGET_INVALID`, `GOV_API_REPLACEMENT_INVALID`, `GOV_API_CONSUMER_INVALID`; 409 `GOV_API_DEPRECATION_EXISTS`, `GOV_API_DEPRECATION_FINAL`, `GOV_API_CONSUMER_EXISTS`; 410 `GOV_API_VERSION_SUNSET`.

## Contract tests em CI (M9-D842)
A API real obedece ao OpenAPI. Código em `api-governance/contract/` (sem banco, só funções): `schema.validate.js` (tipos, obrigatórios, enums, formatos, `$ref`), `response.check.js` (status documentado, corpo, tipo de conteúdo, cabeçalhos documentados, formato único de erro `{success:false,error:{code,message,details?,traceId}}` com `traceId` dentro de `error` e igual a `X-Correlation-Id`, código no catálogo da M9-D843), `coverage.check.js` (positivo e negativo por operação, rota real do escopo ausente do contrato), `examples.*` (leitura e variáveis dos exemplos), `runner.js`, `report.js` e `contract.guard.js`.
- **Comando**: `npm run test:contract` (`scripts/withDisposableDb.js` + semente de dois tenants + `scripts/runContractTests.js`). Recusa banco compartilhado com exit 2 (`GOV_CONTRACT_DB_NOT_DISPOSABLE`): exige `DISPOSABLE_DB=1` e as duas conexões em 127.0.0.1, antes de carregar qualquer configuração. Saída 0 verde, 1 vermelho. Relatórios em `docs/evidencias/ci/`: `contract-report.json` (por exemplo: status, achados, duração; totais; cobertura) e `contract-report.junit.xml`, mais `contract-tests.junit.xml` do runner. CI: `.github/workflows/contract-tests.yml`, em todo pull request.
- **Exemplos**: `test/marco9/_helpers/contract-examples/*.json`, na ordem dos arquivos. Cada exemplo: `op` ("MÉTODO /caminho do contrato"), `kind` (`positive` espera 2xx; `negative` espera um 4xx documentado na operação), `name`, `as` (`gestor`, `maker`, `gestorB`, `anon`), `expect`, e opcionais `params`, `query`, `headers`, `body`, `capture` (`"var": "body.data.id"`; `#nome` lê o parâmetro da URL), `seed` (dados de partida de `test/marco9/_helpers/m9d842Seeds.js`), `mfa` (passo de verificação recente inserido no cluster descartável, nunca por HTTP) e `clearMfa`. `${var}`, `${uuid}`, `${key}`, `${unique}`, `${code}`, `${ref:FIN}`, `${date:+N}` e `${datetime:+N}` são resolvidos na hora.
- **Cobertura**: toda operação do contrato tem exemplo positivo e negativo; operação sem nenhum 4xx documentado reprova (`GOV_CONTRACT_EXAMPLE_MISSING`); `x-always-error: true` (item do calendário, sempre 404) dispensa o positivo; rota real do escopo (`openapi/escopo.json`) ausente do contrato reprova (`GOV_OPENAPI_ROUTE_UNDOCUMENTED`); rota fora do escopo não é exigida.
- **Extensões do contrato lidas pelo teste**: `x-error-code` (código esperado) e `x-error-codes` (outros códigos aceitos no mesmo status, como os de MFA), além de `headers` (obrigatório ausente reprova) e `content` (tipo diferente do documentado reprova).
- **Códigos**: `GOV_RESPONSE_SCHEMA_MISMATCH`, `GOV_STATUS_NOT_DOCUMENTED`, `GOV_CONTRACT_EXAMPLE_MISSING`, `GOV_CONTRACT_EXAMPLE_INVALID`, `GOV_CONTRACT_DB_NOT_DISPOSABLE`; o `GOV_ERROR_CODE_UNKNOWN` é da M9-D843 e aqui só é verificado.
- **Execução vermelha de propósito**: `CONTRACT_OPENAPI_FILE=<contrato alterado>` troca o contrato lido sem tocar no arquivo versionado.

## API externa com client credentials e scopes (M9-D844)
Código em `api-governance/clients/`. Parceiros e provedores acessam `/api/v1/api-external/*` com credencial própria, nunca com o login de um colaborador.
- **Credencial** (`governance.api_clients`, migration 846): `client_id` público (`nyc_...`), segredo (`nys_...`) mostrado UMA vez na criação e guardado só como hash bcrypt, `scopes[]`, `status` `ACTIVE` ou `REVOKED`, `consumer_id`. Criar (`POST /api-governance/clients`: `name`, `kind` `PARTNER` ou `PROVIDER`, `ownerUserId`, `scopes`) cria no mesmo ato o consumidor da M9-D841 (`registerConsumer`); revogar (`POST /api-governance/clients/:id/revoke`) exige `governance:api:manage`; `GET /api-governance/clients` lista sem segredo. Não existe rotação: revoga-se e cria-se outra. A repetição de `Idempotency-Key` na criação devolve a credencial sem o segredo (`res.locals.idempotencyStoredBody`).
- **Scopes** (`governance.api_scopes`, migration 845): catálogo fechado `<recurso>:<ação>`, separado das permissões internas: `properties:read`, `leads:write`, `contracts:read`. Scope novo só entra por migration.
- **Token**: `POST /api-external/oauth/token` (JSON ou formulário, RFC 6749) com `grant_type=client_credentials`, `client_id`, `client_secret` e `scope` opcional (separados por espaço). Devolve `access_token` (JWT `typ=client`, sem usuário), `token_type`, `expires_in` (padrão 900 s) e `scope` (interseção entre o pedido e o permitido; vazia: 400 `GOV_INVALID_SCOPE`).
- **Separação**: token de cliente nas rotas internas é 401 `GOV_AUTH_INVALID_TOKEN_TYPE` (`auth.middleware.js`); token de usuário em `/api-external/*` também. Vencido: 401 `GOV_TOKEN_EXPIRED`. Sem o scope da rota: 403 `GOV_INSUFFICIENT_SCOPE`.
- **Revogação imediata**: cada chamada externa confere `api_clients.status` do `client_id` (consulta indexada, sem cache); `REVOKED` é 401 `GOV_CLIENT_DISABLED`, mesmo com o JWT ainda dentro da validade.
- **Rotas externas**: `GET /api-external/properties` (`properties:read`, só os campos públicos do read model da M9-D231), `POST /api-external/leads` (`leads:write`, cria pessoa e oportunidade Nova pelos serviços da tela) e `GET /api-external/contracts` (`contracts:read`, dados resumidos). Toda rota declara o scope com `requireScope`; `external.sweep.js` reprova rota sem scope (a API nem sobe) e o teste de varredura cobre o router real.
- **Rastro e limite**: o `client_id` do token alimenta o rastro de uso da D841 (rota e major, também na emissão do token) e o limite por credencial da D843 (o contador é por `client_id`, não por token).
- **Parâmetros** (aba Governança): `governanca.api.cliente.token_validade_s` (900), `governanca.api.cliente.segredo_custo` (10) e `governanca.api.externo.lead_prazo_horas` (24).
