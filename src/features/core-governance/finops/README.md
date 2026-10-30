# Governança — FinOps (`finops`)

## Objetivo
FinOps: coletores de custo, orçamento por ambiente e domínio, alertas 50/75/90/100 sem nunca derrubar a produção. Este módulo nasce no alicerce M9-D800 (esqueleto, permissões, liga/desliga e rota do livro); as regras entram em M9-D860 a M9-D863, e cada demanda dona atualiza este README no mesmo commit.

## Tabelas
`governance.cost_ledger` (livro-razão em centavos inteiros; ESTIMATED x BILLED; CHARGE x CREDIT; unicidade com empresa e domínio; `superseded_by`), `cost_read_model` (agregado por dia, ambiente, domínio, categoria e tipo; não conta linha substituída), `cost_accruals` (uso por hora antes de virar linha; frações de centavo em escala 1e6) e `cost_collector_runs` (último sucesso e última falha por coletor). RLS pelo grupo no ledger e no read model (empresa nula = custo compartilhado, só administrador vê), pela empresa nas demais. Migrations 20260101000860 a 862.

M9-D861: `governance.budgets` (orçamento mensal por empresa, ambiente e domínio ou PLATFORM, em centavos inteiros, único por escopo) e `governance.budget_alerts` (um registro por limiar 50/75/90/100 disparado, UNIQUE por orçamento, mês e limiar; `seq` guarda a ordem). RLS + FORCE pela empresa. Migrations 20260101000816 e 817.

Antes (alicerce): nenhuma. O alicerce cria o schema `governance` e a função `governance.apply_tenant_rls(regclass)`, que toda tabela do módulo chama na sua migration (faixa 20260101000800 a 20260101000869 no bloco E) para ganhar RLS + FORCE RLS, política `tenant_isolation` e GRANT protegido por existência do role `nayara_runtime`. Colunas padrão: `id uuid`, `group_id`, `company_id`, `created_at`, `updated_at`.

## Rotas e permissões
- `GET /finops/health` devolve `custos.estimado` e `custos.faturado` (séries separadas, cada uma com o seu total; nunca total misto) e `coletores`. Traz também `orcamentos` (M9-D861): cada orçamento do mês com as duas séries lado a lado (`consumo.estimado` e `consumo.faturado`, cada uma com o seu total), a série-base do percentual, o percentual e os limiares disparados. Exige `governance:finops:read` e o módulo ligado para a empresa. Sem login: 401 `MISSING_ACCESS_TOKEN`; sem permissão: 403 `PERMISSION_DENIED`; módulo desligado: 403 `GOV_MODULE_DISABLED`.
- `GET /finops/budgets` (leitura), `POST /finops/budgets` e `PATCH /finops/budgets/:id` (`governance:finops:manage`): orçamento por ambiente e domínio. Erros: 422 `GOV_BUDGET_AMOUNT_INVALID` (valor zero, negativo ou fracionado), 422 `GOV_BUDGET_OWNER_REQUIRED` / `GOV_BUDGET_OWNER_INVALID`, 422 `GOV_BUDGET_SCOPE_INVALID`, 409 `GOV_BUDGET_DUPLICATE`, 404 `GOV_BUDGET_NOT_FOUND`.
- Corpo de erro único: `{success:false,error:{code,message,details?,traceId}}` (traceId dentro de `error`).

## Eventos
- `finops.budget.threshold` (M9-D861; publicado via `publishGovernanceEvent`, na mesma transação do alerta, com `idempotencyKey` `finops.budget.threshold:<orçamento>:<mês>:<limiar>`). Carga: `budgetId, environment, domain, threshold, percent, consumedCents, budgetCents` e, a mais, `periodStart, series, estimatedCents, billedCents`. O alerta 100 só publica o evento e avisa o responsável: a política de degradação (M9-D863) é quem consome o evento; nada aqui desliga serviço.

## Jobs e horários
`finopsCollectJob` (M9-D860): a cada 10 minutos fecha as horas encerradas de IA, mensageria e egress (uma linha inteira por hora, half-even) e importa fatura se houver fonte; uma vez por dia, em `governanca.finops.storage_hora` (02:00 de Brasília), mede o armazenamento do dia anterior (arquivos por tipo, bucket e logs). `FINOPS_COLLECT_JOB_DISABLED=true` desliga no processo. Ganchos: fim de execução da NAY (runLifecycle), envio confirmado (dispatch.transition) e contador de bytes de download (middleware `egressMeterMiddleware`).

Orçamentos (M9-D861): sem job próprio. A avaliação roda a CADA gravação do ledger (coleta horária, diária ou fatura), na mesma transação, para os meses tocados (`budgets/budget.evaluate.js`, gancho em `ledger.service.js`), com `FOR UPDATE` do orçamento. Mês aberto (ou fechado sem fatura): percentual sobre a série ESTIMATED e dispara os limiares; mês fechado com fatura BILLED: percentual FINAL sobre a série BILLED, sem disparar. Estimado e faturado nunca são somados.

Antes: nenhum job no alicerce. Jobs deste módulo (se houver) são definidos pela demanda dona e listados aqui com horário e parâmetro que o controla.

## Parâmetros
- `governanca.modulos.finops.habilitado` (booleano, padrão ligado): o administrador liga ou desliga o módulo para a empresa em Configurações > Governança.
- M9-D860: `governanca.finops.moeda`, `.ambiente`, `.precos` (JSON de centavos por unidade), `.gb_base`, `.storage_hora`, `.janela_dias`.
- Demais parâmetros do módulo: acrescentados pela demanda dona em `governance.settings.js` e em `SETTINGS_SCHEMA`, sempre com padrão do catálogo (`Maturacao/demandas/parametros.csv`).

## Decisões (ADR)
- K5: corpo de erro único com `error.traceId`; K4: código novo com prefixo `GOV_` (lista fechada de exceções configurável em `governanca.erros.excecoes_prefixo_gov`).
- Padrão do projeto de deixar o administrador decidir: tudo que é regra alternativa, limite, prazo, canal ou liga/desliga vira parâmetro, nunca valor fixo no código.
- Decisões de implementação do bloco: `Maturacao/demandas/decisoes-de-implementacao.md`.

## Como testar
`node scripts/withDisposableDb.js --port <porta> -- ...` com `test/m9d800.alicerceGovernanca.test.js` (alicerce) e os testes da demanda dona. Nunca contra o banco do `.env`.

## Como diagnosticar
Use o `traceId` da resposta de erro (igual ao cabeçalho `X-Correlation-Id`) para achar a requisição nos logs e no registro de auditoria. Módulo respondendo 403 `GOV_MODULE_DISABLED`: conferir a chave `governanca.modulos.finops.habilitado` em Configurações > Governança.
