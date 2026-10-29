# Governança — Proteção contra vazamento (DLP) (`dlp`)

## Objetivo
Proteção contra vazamento: classificação, política de exportação, máscara e bloqueio (exportação RESTRICTED sem MFA bloqueia). Este módulo nasce no alicerce M9-D800 (esqueleto, permissões, liga/desliga e rota do livro); as regras entram em M9-D820 a M9-D825, e cada demanda dona atualiza este README no mesmo commit.

## Tabelas
- `governance.dlp_policies` (M9-D820, migration 20260101000820): a política da empresa, uma linha por (classificação, ação) = 4 x 6 = 24 linhas (`allowed`, `require_permission`, `require_justification`, `require_mfa`, `require_audit`, `require_watermark`, `require_mask`, `max_rows`, `max_expiry_hours`, `updated_by`). As linhas nascem na primeira leitura (matriz padrão + parâmetros `governanca.dlp.*`). RLS + FORCE por `company_id`.

- `governance.export_jobs` (M9-D821, migration 20260101000821): todo pedido de exportar, compartilhar, imprimir ou baixar, inclusive o bloqueado (`status` REQUESTED, BLOCKED, APPROVED, GENERATING, READY, EXPIRED, REVOKED ou FAILED; `block_reason` POLICY, SUSPENDED, PERMISSION, PURPOSE, MFA ou VOLUME; `decision_trace` com as 6 etapas; `kind` EXPORT, SHARE, PRINT ou DOWNLOAD; `idempotency_key` única por empresa). RLS + FORCE por `company_id`.

- `governance.access_signals` (M9-D824, migration 20260101000830): cada leitura de HIGH/RESTRICTED (`kind` READ), cópia (COPY) e pedido de exportação, compartilhamento ou impressão aprovado ou bloqueado (EXPORT), com `count` itens e `outcome` ALLOWED ou DENIED. RLS + FORCE por `company_id`.
- `governance.access_anomalies` (M9-D824, migration 20260101000831): a anomalia de acesso em massa (`kind` READ ou EXPORT; `status` OPEN, CONFIRMED ou FALSE_POSITIVE; `trigger_signals`, `restricted_until`, `mfa_forced_since`, `mfa_forced_until`, revisão com motivo). Índice único parcial `(company_id, user_id, kind) WHERE status = 'OPEN'`. RLS + FORCE.
- `governance.user_dlp_state` (M9-D824, migration 20260101000832): o estado que o IAM e o guard leem (`dlp_restricted_until`, `mfa_step_up_forced_until`, `mfa_forced_since`), recalculado das anomalias abertas ou confirmadas. RLS + FORCE.

Demais tabelas: ainda nenhuma. O alicerce cria o schema `governance` e a função `governance.apply_tenant_rls(regclass)`, que toda tabela do módulo chama na sua migration (faixa 20260101000800 a 20260101000869 no bloco E) para ganhar RLS + FORCE RLS, política `tenant_isolation` e GRANT protegido por existência do role `nayara_runtime`. Colunas padrão: `id uuid`, `group_id`, `company_id`, `created_at`, `updated_at`.

## Rotas e permissões
- `GET /dlp` exige `governance:dlp:admin` e o módulo ligado para a empresa (esqueleto do alicerce: devolve o estado do módulo). Sem login: 401 `MISSING_ACCESS_TOKEN`; sem permissão: 403 `PERMISSION_DENIED`; módulo desligado: 403 `GOV_MODULE_DISABLED`.
- `GET /dlp/policies` (`governance:dlp:export` ou `governance:dlp:admin`) devolve as 24 linhas; `PUT /dlp/policies/:classification/:action` (`governance:dlp:admin`) altera só os campos enviados, recusa enfraquecer o piso do livro (EXPORT de HIGH/RESTRICTED sem justificativa, MFA, auditoria ou expiração: 422 `GOV_DLP_FLOOR_VIOLATION`), valida (400 `GOV_DLP_POLICY_INVALID`) e audita `governance.dlp_policy.changed` com antes e depois. Mesmo conteúdo: nada muda, nada é auditado.
- Guard (M9-D821, sem rota própria; usado por `POST /exports` da D822, links da D823 e IA): `guard.service.js#decide(tenant, pedido)` percorre CLASSIFICATION -> PERMISSION -> PURPOSE -> MFA -> VOLUME -> DECISION (função pura `dlp.guard.js#evaluate`; a primeira falha encerra, as demais ficam SKIPPED no rastro). EXPORT, SHARE e PRINT (kind EXPORT, SHARE, PRINT ou DOWNLOAD) gravam o `export_jobs` ANTES de avaliar, numa transação própria que o rollback do negócio não desfaz, auditam o bloqueio e publicam `dlp.export.blocked` uma vez; VIEW, COPY e AI rodam em modo leve (etapas 1, 2, 4 e 6, sem pedido). Erros por motivo em `guard.reasons.js` (`blockedError`): GOV_DLP_DENIED, GOV_DLP_USER_SUSPENDED, GOV_DLP_PERMISSION, GOV_DLP_PURPOSE_REQUIRED, MFA_STEP_UP_REQUIRED, GOV_DLP_VOLUME_EXCEEDED. Pontos de encaixe das demandas seguintes: `classification.resolver.js#setResolver` (M9-D910, hoje stub = classe padrão), `suspension.reader.js#setReader` e `signals.sink.js#setSignalSink` (M9-D824).
- VIEW e COPY em execução (M9-D825): `view.routes.js` monta `enforceViewPolicy(resourceType)` nos prefixos `/people`, `/properties`, `/procurement`, `/legal/contracts`, `/finance` e `/files` (em `src/routes/index.js`). A resposta de sucesso é varrida atrás dos campos HIGH e RESTRICTED do registro (`governanca.dlp.view.campos`, encaixe `view.fields.js#setFieldSource` para a M9-D910); para cada classe presente o guard decide VIEW (modo leve, audita `governance.dlp.view` uma linha por recurso e por janela e entrega o sinal). RESTRICTED sem `governance:dlp:view-restricted` sai MASCARADO (`****` + últimos caracteres do parâmetro `governanca.dlp.view.mascara_ultimos`); falha ao decidir mascara HIGH e RESTRICTED por inteiro (`********`). Nenhum parâmetro de rota liga a máscara de volta.
- `POST /dlp/copy-events` (M9-D825, só login): corpo `{resourceType, resourceId, field, outcome: 'ALLOWED'|'DENIED'}`, 201 `{id}`; `DENIED` sempre aceito (auditoria `governance.dlp.copy.blocked` e sinal COPY negado); `ALLOWED` reavalia a política: campo que nega a cópia devolve 403 `GOV_DLP_DENIED` ("Este dado não pode ser copiado.") e registra a negação; campo fora do registro: 400 `GOV_DLP_POLICY_INVALID`; LOW e MEDIUM: 201 com `id` nulo, sem registro. Front: `components/molecules/ProtectedValue` e `lib/dlp/protectedValue.logic.js`.
- Corpo de erro único: `{success:false,error:{code,message,details?,traceId}}` (traceId dentro de `error`).

## Eventos
- `dlp.export.blocked` (publicado pelo serviço do módulo via `publishGovernanceEvent`, na mesma transação, com `idempotencyKey`).

## Jobs e horários
Nenhum job no alicerce. Jobs deste módulo (se houver) são definidos pela demanda dona e listados aqui com horário e parâmetro que o controla.

## Parâmetros
- `governanca.modulos.dlp.habilitado` (booleano, padrão ligado): o administrador liga ou desliga o módulo para a empresa em Configurações > Governança.
- `governanca.dlp.classificacao_padrao`, `volume_teto_por_classe`, `expiracao_horas_da_classe` (o único parâmetro de prazo), `watermark.padrao_por_classe`, `finalidades` e `justificativa_min`: política inicial e catálogo da D821 (aba Governança, grupo "Proteção contra vazamento (DLP)").
- `governanca.dlp.anomalia.limiares`, `mfa_horas`, `suspensao_horas` e `confirmada_horas` (M9-D824) e `governanca.dlp.view.campos`, `mascara_ultimos` e `auditoria_janela_min` (M9-D825): abas "Proteção contra vazamento" da aba Governança.
- Demais parâmetros do módulo: acrescentados pela demanda dona em `governance.settings.js` e em `SETTINGS_SCHEMA`, sempre com padrão do catálogo (`Maturacao/demandas/parametros.csv`).

## Decisões (ADR)
- K5: corpo de erro único com `error.traceId`; K4: código novo com prefixo `GOV_` (lista fechada de exceções configurável em `governanca.erros.excecoes_prefixo_gov`).
- Padrão do projeto de deixar o administrador decidir: tudo que é regra alternativa, limite, prazo, canal ou liga/desliga vira parâmetro, nunca valor fixo no código.
- Decisões de implementação do bloco: `Maturacao/demandas/decisoes-de-implementacao.md`.

## Como testar
`node scripts/withDisposableDb.js --port <porta> -- ...` com `test/m9d800.alicerceGovernanca.test.js` (alicerce) e os testes da demanda dona. Nunca contra o banco do `.env`.

## Como diagnosticar
Use o `traceId` da resposta de erro (igual ao cabeçalho `X-Correlation-Id`) para achar a requisição nos logs e no registro de auditoria. Módulo respondendo 403 `GOV_MODULE_DISABLED`: conferir a chave `governanca.modulos.dlp.habilitado` em Configurações > Governança.
