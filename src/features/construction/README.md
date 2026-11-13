# Módulo `construction` (Obras e Pós-obra) — decisões de engenharia

Este arquivo documenta duas decisões de engenharia do Marco 6 que a fonte (Anexo I) deixa como
lacuna documental — ver `Maturacao/CHECKLIST_DE_ESCOPO/marcos/marco_06_obras_e_pos_obra.md`,
itens M6-102 e M6-103.

## M6-103 — Schema físico: fusão de entidades da spec em tabelas mais simples

O Anexo I descreve conceitualmente 16 entidades para o módulo (`projects`, `project_stages`,
`stage_dependencies`, `budgets`, `budget_items`, `change_orders`, `daily_logs`,
`daily_workers`, `daily_materials`, `measurements`, `measurement_items`, `quality_checks`,
`nonconformities`, `loss_records`, `warranty_cases`, `warranty_actions`), mas só detalha
campo-a-campo o catálogo físico de duas delas (`projects`/TAB-0700 e
`project_stages`/TAB-0701). As outras 14 não têm especificação de coluna — são descritas em
prosa, sem tabela física.

**Decisão (atualizada em 30/09/2026; tabelas novas na verificação independente de 11/11/2026)**: o
schema real deste módulo usa **22 tabelas físicas** (as 19 originais + `project_types`, `checklist_templates` e `budget_revisions`). A maioria das 16 entidades conceituais da
spec agora tem tabela própria de verdade; a única fusão que permanece é `daily_reports`
(diário) absorvendo equipe/materiais do dia como tabelas-filhas relacionadas (não campos soltos
— `daily_workers`/`daily_materials` são tabelas reais vinculadas por `daily_report_id`), porque
a fonte trata o RDO como um único registro por `(project_id, report_date, shift_code)` com
equipe/material anexados, não três entidades independentes:

| Tabela física | Mapeamento pra entidade conceitual da fonte | Situação |
|---|---|---|
| `construction.projects` | `projects` | 1:1, real. |
| `construction.project_stages` | `project_stages` | 1:1, real. |
| `construction.stage_dependencies` | `stage_dependencies` | 1:1, real (M6-03/M6-19). |
| `construction.budgets` | `budgets` | 1:1, real — agregado com baseline imutável (M6-04/M6-17). |
| `construction.budget_lines` | `budget_items` | Nome diferente (`budget_lines` em vez de `budget_items`), mesmo papel — linha de item vinculada a `budgetId`. |
| `construction.change_orders` | `change_orders` | 1:1, real (M6-06/M6-33). |
| `construction.daily_reports` | `daily_logs` | 1:1 no conceito de "diário do dia"; equipe/materiais viram tabelas-filhas (ver abaixo), não campos soltos. |
| `construction.daily_workers` | `daily_workers` | 1:1, real (tabela-filha de `daily_reports`). |
| `construction.daily_materials` | `daily_materials` | 1:1, real (tabela-filha de `daily_reports`). |
| `construction.stage_measurements` | `measurements` | 1:1, real — máquina de estados completa DRAFT→SUBMITTED→REVIEWED→APPROVED→PAYABLE. |
| `construction.measurement_items` | `measurement_items` | 1:1, real (M6-11). |
| `construction.quality_checklist_items` | `quality_checks` | 1:1, com categoria; o item gerado do checklist do tipo de obra guarda `checklist_template_id` e `failure_severity` (M6-12/M6-86). |
| `construction.nonconformities` | `nonconformities` | 1:1, real (M6-13), incluindo alerta de evidência reutilizada (M6-59). |
| `construction.loss_records` | `loss_records` | 1:1, real (M6-14), com alçada de aprovação por valor. |
| `construction.maintenance_cases` | `warranty_cases` | 1:1 — nome diferente, mesmo papel: caso de garantia estruturado (category/severity/SLA/mídia/custos). |
| `construction.warranty_actions` | `warranty_actions` | 1:1, real (M6-16), tabela própria vinculada a `maintenance_cases`. |
| `construction.material_requests` | requisição mínima de material (M6-28) | Nova (não prevista como entidade separada na spec) — mínimo exigido pelo Marco 6, integração completa de estoque é Marco 7. |
| `construction.project_code_sequences` | (suporte, não é entidade de negócio) | Contador atômico para gerar `Project.code` (M6-01), mesmo padrão de `legal.contract_number_sequences`. |
| `construction.approval_thresholds` | (suporte, não é entidade de negócio) | Alçada por valor de cada empresa: perda de material (MATERIAL_LOSS) e desconto/ressarcimento de garantia (WARRANTY_RESOLUTION). Sem valor no código (M6-96). |
| `construction.project_types` | tipo de obra (§9) | Cadastrado pelo administrador; a obra tem `project_type_id`. |
| `construction.checklist_templates` | checklist por etapa/tipo de obra (§9) | Item configurado por tipo (nulo = todos) e código da etapa (nulo = item da obra), com a severidade da NC. |
| `construction.budget_revisions` | revisões do orçamento aprovado (Guia §3) | Append-only (gatilho recusa UPDATE/DELETE): uma por Change Order aprovado. |

A única simplificação que resta em relação à spec conceitual original é o agrupamento de
equipe/material do dia como tabelas-filhas do diário (em vez de entidades totalmente
independentes sem vínculo) — decisão consciente, não perde nenhuma informação exigida pela
fonte, e é exatamente como a fonte descreve o conceito de "diário" em prosa (um registro do dia
com equipe e materiais anexados).

### M6-28 — Requisição de material e integração com Estoque

`construction.material_requests` nasce da obra/etapa (`stage_id`; quando a requisição foi criada sem etapa, a etapa é
informada no recebimento). O recebimento exige item e local reais do Estoque e gera a baixa (OUT) vinculada à obra e à
etapa; a devolução gera o movimento inverso (RETURN). A perda/quebra (`loss_records`) e a devolução da perda estão em
`lossRecords.service.js`, com alçada por valor. Os locais de estoque informados precisam ser da mesma empresa.

## M6-102 — Backup/restore (Disaster Recovery, Tier 1)

Citação literal do contrato (seção "HOMOLOGAÇÃO — BLINDADO v1", item 10 "RPO/RTO por classe"):
"TIER 1 — CRM, locação, obras, estoque: RPO/RTO intermediário." O mesmo bloco (item 9 "Backup")
exige literalmente: "PostgreSQL: backups automáticos + PITR/WAL conforme infraestrutura" e
"Backup sem restore testado não conta como backup confiável" — ou seja, a própria fonte trata
backup/restore/PITR como responsabilidade de **infraestrutura/operação** (nível de banco
completo), não como uma feature de código por módulo. Nenhuma linha do Anexo I ("CONSTRUÇÃO +
OBRAS + PÓS-OBRA — BLINDADO v1") pede um endpoint de export/snapshot específico de Obras — a
revisão deste item (fechamento de gaps pós-Marco 6, item 5) confirmou isso lendo o texto bruto
do PDF e concluiu que inventar um endpoint de snapshot aqui seria trabalho artificial fora do
escopo literal, não um requisito real do contrato.

**Decisão**: este módulo **não tem um mecanismo de backup/restore
próprio/dedicado** — ele é coberto pelo mecanismo geral de backup/restore do banco Postgres
inteiro (todas as 19 tabelas do schema `construction`, com RLS `ENABLE + FORCE` ativado,
participam do dump/restore do banco como qualquer outro schema do sistema). Isso é uma decisão
consciente, não uma lacuna: criar um mecanismo de backup separado por módulo adicionaria
complexidade operacional (múltiplos pontos de restore, risco de dessincronia entre schemas)
sem ganho real, já que o RPO/RTO do Tier 1 é perfeitamente atendível por um backup/restore de
banco completo bem operado (rotina de `pg_dump`/WAL archiving + teste periódico de restore,
mesmo mecanismo usado pelos demais módulos do sistema). Se no futuro Obras precisar de um RPO
mais agressivo que os demais módulos Tier 1, isso justificaria revisitar esta decisão — não há
indicação disso na fonte hoje.

**Garantia de nível de aplicação que torna um restore seguro** (mesmo raciocínio de M4-25 —
`test/marco4.finance.batch3.test.js` — aplicado aqui): o "restore de banco" em si é
responsabilidade de infraestrutura, não deste código; o que este módulo garante é que
reprocessar (replay) uma operação já processada, depois de um restore, NUNCA duplica efeito
colateral real. Isso está comprovado por teste real: `M6-94` (idempotencyKey de RDO — reenviar
o mesmo registro offline após "restore" não duplica), `M6-55`/`M6-68` (aprovar a mesma medição
duas vezes, sob concorrência real com `Promise.allSettled`, nunca cria duas contas a pagar).

## Verificação independente do Marco 6 (11/11/2026) — regras novas

Decisões registradas como DI-M6V-N em `Maturacao/demandas/decisoes-de-implementacao.md`.

- **Baseline imutável (M6-17/M6-82/M6-42, Guia §3):** a aprovação do Change Order não faz UPDATE em
  `budgets.baseline_amount`/`total_amount` nem em `projects.budget_amount`; cria uma revisão em `budget_revisions`
  (`budgetRevisions.service.js`). O banco recusa UPDATE na baseline de orçamento APPROVED (gatilho
  `budgets_baseline_immutable`). O read model mostra `baselineBudget` (a aprovada), `approvedChanges` (os aditivos) e
  `currentApprovedBudget` (a soma). `GET /construction/projects/:id/budget-revisions`.
- **Medição (M6-21, Guia §6, Caderno §7):** `stage_measurements.evidence_file_ids` (arquivos reais da empresa, examinados
  pelo antivírus; mudam só por revisão). A aprovação confere de novo cada evidência e o mínimo da empresa
  (`construction.medicao.evidencias_minimas`). APPROVED publica `measurement.approved`; o consumidor do Financeiro
  (`src/modules/finance/application/services/measurement-payable.consumer.js`) cria a conta a pagar com
  `source_event_id` (índice único). A aprovação aciona esse consumidor na mesma transação (`runNamedConsumer`), então a
  medição só vira PAYABLE com a conta criada (CHECK `stage_measurements_payable_has_entry`); o despachante reentrega o
  evento e o consumidor devolve a conta existente.
- **Referências da mesma empresa (M6-08, M6-95, M6-104 e varredura):** `companyRefs.js` confere unidade, imóvel, pessoa
  (prestador), obra, etapa, local de estoque e usuário (membro ativo) antes de gravar; outra empresa = 422
  `CONSTRUCTION_REFERENCE_NOT_IN_COMPANY`. O documento do prestador no RDO é arquivo real, examinado pelo antivírus.
- **Etapa (M6-19/M6-81):** `project_stages.responsible_user_id`, membro ativo; exigido para iniciar a etapa.
- **Tipo de obra e checklist (M6-12/M6-86):** `projectTypes.service.js` e `checklistTemplates.service.js`; a obra recebe
  os itens do seu tipo por etapa (ao ganhar tipo, etapa ou código de etapa, e por `POST /projects/:id/checklist/apply`);
  a reprovação abre NC com a severidade do modelo.
- **Alçada (M6-29/M6-107/M6-96):** `approvalThresholds.service.js`. Alterar exige `construction:approval_threshold:manage`
  e MFA recente (rota) e audita antes/depois. Sem alçada configurada, nada se autoaprova. Acima da alçada, quem propõe o
  desconto/ressarcimento de garantia não aprova.
- **Diário ausente (M6-108):** regra da empresa em `construction.diario_ausente.*` (`missingDailyReportRule.js`).
- **Baixa parcial (M6-97):** a baixa filha carrega `construction_project_id`; drill-down, painel e read model de BI
  contam o pago uma vez (obrigação quitada não soma de novo com as baixas).
- **Scanner (M6-96):** `scripts/scanConstructionHardcode.js` acusa 1500, 2500, 1000.0 e percentual inteiro.
- **Parâmetros de Obras:** `construction.settings.js` (catálogo) e `GET/PUT /construction/settings/parameters`.
