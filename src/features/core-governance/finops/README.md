# Governança — FinOps (`finops`)

## Objetivo
FinOps: coletores de custo, orçamento por ambiente e domínio, alertas 50/75/90/100 sem nunca derrubar a produção. Este módulo nasce no alicerce M9-D800 (esqueleto, permissões, liga/desliga e rota do livro); as regras entram em M9-D860 a M9-D863, e cada demanda dona atualiza este README no mesmo commit.

## Tabelas
`governance.cost_ledger` (livro-razão em centavos inteiros; ESTIMATED x BILLED; CHARGE x CREDIT; unicidade com empresa e domínio; `superseded_by`), `cost_read_model` (agregado por dia, ambiente, domínio, categoria e tipo; não conta linha substituída), `cost_accruals` (uso por hora antes de virar linha; frações de centavo em escala 1e6) e `cost_collector_runs` (último sucesso e última falha por coletor). RLS pelo grupo no ledger e no read model (empresa nula = custo compartilhado, só administrador vê), pela empresa nas demais. Migrations 20260101000860 a 862.

M9-D861: `governance.budgets` (orçamento mensal por empresa, ambiente e domínio ou PLATFORM, em centavos inteiros, único por escopo) e `governance.budget_alerts` (um registro por limiar 50/75/90/100 disparado, UNIQUE por orçamento, mês e limiar; `seq` guarda a ordem). RLS + FORCE pela empresa. Migrations 20260101000816 e 817.

M9-D862: `governance.finops_findings` (achados dos detectores: `detector`, `subject`, `evidence` jsonb, `estimated_waste_cents`, `status` OPEN|RESOLVED, `first_seen_at`, `last_seen_at`; índice único parcial `(company_id, detector, subject) WHERE status = 'OPEN'`). RLS + FORCE pela empresa. Migration 20260101000818.

M9-D863: `governance.degradation_policies` (uma por orçamento: lista ORDENADA de passos com limiar 50/75/90/100; único por orçamento) e `governance.degradation_actions` (cada passo aplicado: `step`, `threshold`, `period_start`, `status` APPLIED|REVERTED, `previous_value`, `trigger_event_id`; CHECK com os cinco passos de função; índice único parcial = um passo APPLIED por orçamento e período). RLS + FORCE pela empresa. Migrations 20260101000825 e 826 (e 827, que regrava o schema da conexão de IA com o campo opcional `cheaperAlternative`).

Antes (alicerce): nenhuma. O alicerce cria o schema `governance` e a função `governance.apply_tenant_rls(regclass)`, que toda tabela do módulo chama na sua migration (faixa 20260101000800 a 20260101000869 no bloco E) para ganhar RLS + FORCE RLS, política `tenant_isolation` e GRANT protegido por existência do role `nayara_runtime`. Colunas padrão: `id uuid`, `group_id`, `company_id`, `created_at`, `updated_at`.

## Rotas e permissões
- `GET /finops/health` devolve `custos.estimado` e `custos.faturado` (séries separadas, cada uma com o seu total; nunca total misto) e `coletores`. Traz também `orcamentos` (M9-D861): cada orçamento do mês com as duas séries lado a lado (`consumo.estimado` e `consumo.faturado`, cada uma com o seu total), a série-base do percentual, o percentual e os limiares disparados. Exige `governance:finops:read` e o módulo ligado para a empresa. Sem login: 401 `MISSING_ACCESS_TOKEN`; sem permissão: 403 `PERMISSION_DENIED`; módulo desligado: 403 `GOV_MODULE_DISABLED`.
- `GET /finops/health` também traz `achados` (findings abertos dos cinco detectores, com a evidência e o desperdício estimado em centavos) e `detectores` (última execução e falhas de cada um).
- `GET /finops/budgets` (leitura), `POST /finops/budgets` e `PATCH /finops/budgets/:id` (`governance:finops:manage`): orçamento por ambiente e domínio. Erros: 422 `GOV_BUDGET_AMOUNT_INVALID` (valor zero, negativo ou fracionado), 422 `GOV_BUDGET_OWNER_REQUIRED` / `GOV_BUDGET_OWNER_INVALID`, 422 `GOV_BUDGET_SCOPE_INVALID`, 409 `GOV_BUDGET_DUPLICATE`, 404 `GOV_BUDGET_NOT_FOUND`.
- `GET /finops/health` (M9-D863) traz também `status` geral (`OK`, `ATTENTION` >= 75%, `CRITICAL` >= 100%; o pior entre ambientes e domínios), `ambientes[].dominios[]` (orçamento, consumo estimado e faturado separados, percentual, `limiarAtual`, `status`, `achadosAbertos` por detector, `dadoIncompleto` e `aviso`), `collectors[]` (`state` OK ou STALE com `lastDataAt`; STALE não é valor do `status`), `achadosPorDetector` e `degradacoes`. O status nunca afeta a disponibilidade do sistema.
- `GET /finops/degradation-policies` (`governance:finops:read`) e `PUT /finops/degradation-policies` (`governance:finops:manage`; corpo `{ budgetId, steps: [{ step, threshold? }], enabled? }`). Erros: 403 `GOV_FINOPS_PROD_PROTECTED` (passo que desligaria infraestrutura), 422 `GOV_FINOPS_CRITICAL_NOT_DEGRADABLE` (função crítica), 422 `GOV_FINOPS_POLICY_INVALID`, 404 `GOV_BUDGET_NOT_FOUND`.
- Corpo de erro único: `{success:false,error:{code,message,details?,traceId}}` (traceId dentro de `error`).

## Eventos
- `finops.budget.threshold` (M9-D861; publicado via `publishGovernanceEvent`, na mesma transação do alerta, com `idempotencyKey` `finops.budget.threshold:<orçamento>:<mês>:<limiar>`). Carga: `budgetId, environment, domain, threshold, percent, consumedCents, budgetCents` e, a mais, `periodStart, series, estimatedCents, billedCents`. O alerta 100 só publica o evento e avisa o responsável: a política de degradação (M9-D863) é quem consome o evento; nada aqui desliga serviço.

## Jobs e horários
`finopsCollectJob` (M9-D860): a cada 10 minutos fecha as horas encerradas de IA, mensageria e egress (uma linha inteira por hora, half-even) e importa fatura se houver fonte; uma vez por dia, em `governanca.finops.storage_hora` (02:00 de Brasília), mede o armazenamento do dia anterior (arquivos por tipo, bucket e logs). `FINOPS_COLLECT_JOB_DISABLED=true` desliga no processo. Ganchos: fim de execução da NAY (runLifecycle), envio confirmado (dispatch.transition) e contador de bytes de download (middleware `egressMeterMiddleware`).

Orçamentos (M9-D861): sem job próprio. A avaliação roda a CADA gravação do ledger (coleta horária, diária ou fatura), na mesma transação, para os meses tocados (`budgets/budget.evaluate.js`, gancho em `ledger.service.js`), com `FOR UPDATE` do orçamento. Mês aberto (ou fechado sem fatura): percentual sobre a série ESTIMATED e dispara os limiares; mês fechado com fatura BILLED: percentual FINAL sobre a série BILLED, sem disparar. Estimado e faturado nunca são somados.

Detectores de desperdício (M9-D862), cinco jobs em `src/engines/jobs/finopsDetectorsJob.js`, um por detector (nome de rodada próprio), todos só de leitura: storage órfão, logs excessivos, modelo de IA caro e egress anormal rodam uma vez por dia em `governanca.finops.detectores_hora` (03:00 de Brasília) e olham o dia fechado anterior; fila acumulada roda a cada `governanca.finops.fila_intervalo_min` (5 min). Cada um concilia os achados (abre, atualiza `last_seen_at`, resolve sozinho quando a condição some; idempotente por detector e assunto) e registra a execução em `cost_collector_runs` com nome `det_*`; detector que falha não cria nem resolve achado. `FINOPS_DETECTORS_JOB_DISABLED=true` desliga no processo.

Degradação por custo (M9-D863), `finopsDegradationJob` (`src/engines/jobs/finopsDegradationJob.js`): a cada hora, no minuto `governanca.finops.degradacao.minuto_job` (20), por empresa: desfaz o que deve ser desfeito (novo mês, consumo abaixo do limiar, passo fora da política, degradação desligada) e aplica NO MÁXIMO UM passo por orçamento, o seguinte da política na ordem, se o evento `finops.budget.threshold` do limiar do passo já foi publicado e o consumo atual o sustenta. PROD nunca é desligado: os cinco passos são interruptores de FUNÇÃO (`SWITCH_AI_MODEL_CHEAPER`, `PAUSE_MARKETING_CAMPAIGNS`, `REDUCE_LOG_LEVEL`, `LIMIT_EXPORT_SIZE`, `DEFER_NON_CRITICAL_JOBS`), lidos por quem os consome (roteador de IA, Marketing, logger, DLP e BI, `runForEachCompany`); o CHECK da tabela, a guarda `degradation/prod.guard.js` e a varredura estática do teste impedem qualquer outro. Auditoria `finops.degradation.applied|reverted|policy_saved` com antes e depois. `FINOPS_DEGRADATION_JOB_DISABLED=true` desliga no processo.

Antes: nenhum job no alicerce. Jobs deste módulo (se houver) são definidos pela demanda dona e listados aqui com horário e parâmetro que o controla.

## Parâmetros
- `governanca.modulos.finops.habilitado` (booleano, padrão ligado): o administrador liga ou desliga o módulo para a empresa em Configurações > Governança.
- M9-D860: `governanca.finops.moeda`, `.ambiente`, `.precos` (JSON de centavos por unidade), `.gb_base`, `.storage_hora`, `.janela_dias`.
- M9-D862 (`detectors/detectors.settings.js`): `governanca.finops.orfao_dias` (30), `.log_x_media` (3), `.egress_x_media` (3), `.media_dias` (14), `.fila_max` (5000), `.fila_antigos_min` (50), `.fila_idade_min` (30), `.fila_intervalo_min` (5), `.ia_custo_chamada_centavos` (50), `.detectores_hora` (3). Os preços do GB vêm de `governanca.finops.precos`.
- M9-D863 (`degradation/degradation.settings.js`): `governanca.finops.degradacao.ligada` (ligado), `.limiar_primeiro` (90), `.limiar_demais` (100), `.minuto_job` (20), `.log_nivel` (warn), `.exportacao_percentual` (50), `.jobs_baixa_prioridade` (lista), `.jobs_hora_inicio` (0) e `.jobs_hora_fim` (5).
- Demais parâmetros do módulo: acrescentados pela demanda dona em `governance.settings.js` e em `SETTINGS_SCHEMA`, sempre com padrão do catálogo (`Maturacao/demandas/parametros.csv`).

### Demais parâmetros do módulo (M9-D891: conferência)
Todo parâmetro `governanca.*` lido pelo módulo consta neste README; o valor muda em /painel/configuracoes (aba Governança) e vale na leitura seguinte.

| Chave | Padrão | O que controla |
|---|---|---|
| `governanca.finops.ambiente` | `PROD` | ambiente (PROD, HOMOLOG, DEV) a que esta instalação atribui os custos que coleta. |
| `governanca.finops.gb_base` | `1024` | bytes de 1 GB (1024 = GiB, o padrão da nuvem; 1000 = GB decimal). |
| `governanca.finops.janela_dias` | `30` | dias de histórico que a consulta de saúde (GET /finops/health) mostra. |
| `governanca.finops.log_x_media` | `3` | o volume de log do dia acima de N vezes a média móvel abre o achado de logs excessivos. |
| `governanca.finops.egress_x_media` | `3` | os bytes de saída do dia acima de N vezes a média móvel abrem o achado de egress anormal. |
| `governanca.finops.media_dias` | `14` | dias da média móvel de logs e egress. |
| `governanca.finops.fila_max` | `5000` | eventos PENDING acima disso abrem o achado de fila acumulada. |
| `governanca.finops.fila_antigos_min` | `50` | ao menos N eventos mais velhos que `fila_idade_min` minutos abrem o achado de fila. |
| `governanca.finops.fila_idade_min` | `30` | idade, em minutos, a partir da qual um evento pendente conta como antigo. |
| `governanca.finops.ia_custo_chamada_centavos` | `50` | custo médio por chamada de tarefa simples da IA acima disso abre o achado de modelo caro. |
| `governanca.finops.degradacao.limiar_primeiro` | `90` | limiar padrão (% do orçamento) do primeiro passo da política de degradação. |
| `governanca.finops.degradacao.limiar_demais` | `100` | limiar padrão (% do orçamento) dos passos seguintes. |
| `governanca.finops.degradacao.log_nivel` | `warn` | nível de log aplicado pelo passo REDUCE_LOG_LEVEL. |
| `governanca.finops.degradacao.exportacao_percentual` | `50` | percentual do `max_rows` efetivo que sobra no passo LIMIT_EXPORT_SIZE. |
| `governanca.finops.degradacao.jobs_baixa_prioridade` | `dataQualityScanJob,dataQualityMergeDetectionJob,calendarConflictJob,idempotencyCleanupJob,exportExpiryJob` | nomes dos jobs que o passo DEFER_NON_CRITICAL_JOBS adia, separados por vírgula. |
| `governanca.finops.degradacao.jobs_hora_inicio` | `0` | início (hora de Brasília) da janela em que esses jobs seguem rodando durante o passo. |
| `governanca.finops.degradacao.jobs_hora_fim` | `5` | fim (hora de Brasília) da janela em que esses jobs seguem rodando durante o passo. |

## Decisões (ADR)
- K5: corpo de erro único com `error.traceId`; K4: código novo com prefixo `GOV_` (lista fechada de exceções configurável em `governanca.erros.excecoes_prefixo_gov`).
- Padrão do projeto de deixar o administrador decidir: tudo que é regra alternativa, limite, prazo, canal ou liga/desliga vira parâmetro, nunca valor fixo no código.
- Decisões de implementação do bloco: `Maturacao/demandas/decisoes-de-implementacao.md`.

## Como testar
`node scripts/withDisposableDb.js --port <porta> -- ...` com `test/m9d800.alicerceGovernanca.test.js` (alicerce) e os testes da demanda dona. Nunca contra o banco do `.env`.

## Como diagnosticar
Use o `traceId` da resposta de erro (igual ao cabeçalho `X-Correlation-Id`) para achar a requisição nos logs e no registro de auditoria. Módulo respondendo 403 `GOV_MODULE_DISABLED`: conferir a chave `governanca.modulos.finops.habilitado` em Configurações > Governança.
