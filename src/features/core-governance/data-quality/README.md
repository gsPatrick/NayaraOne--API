# Governança — Dados mestres e qualidade (`data-quality`)

## Objetivo
Dono e curador de cada domínio de dados, regras e problemas de qualidade, alteração em massa de dados mestres com permissão, MFA e auditoria. Este módulo nasce no alicerce M9-D800 (esqueleto, permissões, liga/desliga e rota do livro); as regras entram em M9-D804 a M9-D808, e cada demanda dona atualiza este README no mesmo commit.

## Tabelas
- `governance.data_domains` (M9-D804): um registro por empresa e domínio (`UNIQUE (company_id, code)`), criado sob demanda a partir do parâmetro `governanca.dados.dominios`; a linha serve de trava ao trocar o responsável.
- `governance.data_domain_assignments` (M9-D804): designações de `OWNER` e `STEWARD` com vigência (`valid_from`, `valid_until` nulo = vigente, `designated_by`, `close_reason`). Índice único: um OWNER vigente por domínio; gatilho recusa DELETE (o histórico nunca é apagado). Migration `20260101000804-create-governance-data-domains.js`; `20260101000805` acrescenta o tipo `DQ_DOMAIN_PENDING` ao registro de alertas.

Antes de M9-D804 não havia tabela. O alicerce cria o schema `governance` e a função `governance.apply_tenant_rls(regclass)`, que toda tabela do módulo chama na sua migration (faixa 20260101000800 a 20260101000869 no bloco E) para ganhar RLS + FORCE RLS, política `tenant_isolation` e GRANT protegido por existência do role `nayara_runtime`. Colunas padrão: `id uuid`, `group_id`, `company_id`, `created_at`, `updated_at`.

## Rotas e permissões
- `GET /data-quality` exige `governance:data-quality:read` e o módulo ligado para a empresa (esqueleto do alicerce: devolve o estado do módulo). Sem login: 401 `MISSING_ACCESS_TOKEN`; sem permissão: 403 `PERMISSION_DENIED`; módulo desligado: 403 `GOV_MODULE_DISABLED`.
- `GET /data-quality/domains` (`governance:data-quality:read`): domínios na ordem do parâmetro, cada um com `owner`, `stewards` e `pendencies` (sem owner vigente: "Domínio sem responsável" CRITICAL; sem steward vigente: "Domínio sem steward" HIGH).
- `PUT /data-quality/domains/:code/assignments` (`governance:data-quality:manage`), corpo `{designations:[{role:'OWNER'|'STEWARD', userId}]}`. Para cada papel presente no corpo, os vigentes passam a ser exatamente os listados (quem sai tem `valid_until = now()`, quem entra abre linha, quem já estava continua sem linha nova: idempotente, 200). Trocar o owner é um PUT com outro usuário OWNER; não existe rota de encerramento. Papel ausente do corpo não muda. Erros: 409 `GOV_DOMAIN_OWNER_EXISTS` (duas linhas OWNER no corpo), 422 `GOV_ASSIGNEE_INACTIVE`, 404 `GOV_NOT_FOUND` (usuário de outra empresa ou inexistente), 400 `GOV_DOMAIN_INVALID`, 400 `VALIDATION_ERROR`, 403 `PERMISSION_DENIED` (a permissão exigida segue em `details.required`).
- Usuário desativado (`PATCH /users/:id` com status diferente de ACTIVE) ou com o último vínculo da empresa revogado perde as designações (fechadas, nunca apagadas) e o administrador recebe `Notification` IN_APP (`stewardship.lifecycle.js`).
- Avaliação noturna (M9-D806 chama `notifyPendingDomains`): um aviso IN_APP ao administrador por domínio pendente e por dia (`dq.domain_pending:<domínio>:<AAAA-MM-DD>`, em `governance.calendar_alert_log`).
- Corpo de erro único: `{success:false,error:{code,message,details?,traceId}}` (traceId dentro de `error`).

## Eventos
- `data.quality.issue.opened` (publicado pelo serviço do módulo via `publishGovernanceEvent`, na mesma transação, com `idempotencyKey`).

## Jobs e horários
Nenhum job no alicerce. Jobs deste módulo (se houver) são definidos pela demanda dona e listados aqui com horário e parâmetro que o controla.

## Parâmetros
- `governanca.modulos.data_quality.habilitado` (booleano, padrão ligado): o administrador liga ou desliga o módulo para a empresa em Configurações > Governança.
- `governanca.dados.dominios` (texto, padrão `PESSOAS,IMOVEIS,FORNECEDORES,CRM,FINANCEIRO,CONTRATOS,COMISSOES,OBRAS,ESTOQUE,CORRESPONDENTE,FISCAL`): domínios de dados da empresa, extensível pelo administrador na aba Governança.
- Demais parâmetros do módulo: acrescentados pela demanda dona em `governance.settings.js` e em `SETTINGS_SCHEMA`, sempre com padrão do catálogo (`Maturacao/demandas/parametros.csv`).

## Decisões (ADR)
- K5: corpo de erro único com `error.traceId`; K4: código novo com prefixo `GOV_` (lista fechada de exceções configurável em `governanca.erros.excecoes_prefixo_gov`).
- Padrão do projeto de deixar o administrador decidir: tudo que é regra alternativa, limite, prazo, canal ou liga/desliga vira parâmetro, nunca valor fixo no código.
- Decisões de implementação do bloco: `Maturacao/demandas/decisoes-de-implementacao.md`.

## Como testar
`node scripts/withDisposableDb.js --port <porta> -- ...` com `test/m9d800.alicerceGovernanca.test.js` (alicerce) e os testes da demanda dona. Nunca contra o banco do `.env`.

## Como diagnosticar
Use o `traceId` da resposta de erro (igual ao cabeçalho `X-Correlation-Id`) para achar a requisição nos logs e no registro de auditoria. Módulo respondendo 403 `GOV_MODULE_DISABLED`: conferir a chave `governanca.modulos.data_quality.habilitado` em Configurações > Governança.
