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

**Decisão (atualizada em 30/09/2026, rodada final — fechamento de 100% dos itens M6)**: o
schema real deste módulo usa **19 tabelas físicas**. A maioria das 16 entidades conceituais da
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
| `construction.quality_checklist_items` | `quality_checks` | 1:1, com categoria (M6-12). |
| `construction.nonconformities` | `nonconformities` | 1:1, real (M6-13), incluindo alerta de evidência reutilizada (M6-59). |
| `construction.loss_records` | `loss_records` | 1:1, real (M6-14), com alçada de aprovação por valor. |
| `construction.maintenance_cases` | `warranty_cases` | 1:1 — nome diferente, mesmo papel: caso de garantia estruturado (category/severity/SLA/mídia/custos). |
| `construction.warranty_actions` | `warranty_actions` | 1:1, real (M6-16), tabela própria vinculada a `maintenance_cases`. |
| `construction.material_requests` | requisição mínima de material (M6-28) | Nova (não prevista como entidade separada na spec) — mínimo exigido pelo Marco 6, integração completa de estoque é Marco 7. |
| `construction.project_code_sequences` | (suporte, não é entidade de negócio) | Contador atômico para gerar `Project.code` (M6-01), mesmo padrão de `legal.contract_number_sequences`. |
| `construction.approval_thresholds` | (suporte, não é entidade de negócio) | Configuração de alçada por valor para aprovação de perda de material (M6-29). |

A única simplificação que resta em relação à spec conceitual original é o agrupamento de
equipe/material do dia como tabelas-filhas do diário (em vez de entidades totalmente
independentes sem vínculo) — decisão consciente, não perde nenhuma informação exigida pela
fonte, e é exatamente como a fonte descreve o conceito de "diário" em prosa (um registro do dia
com equipe e materiais anexados).

### M6-28 — Requisição de material (mínimo do Marco 6)

`construction.material_requests` implementa o **mínimo** exigido pelo Marco 6: registrar a
requisição (`description`, `quantity`, `unit`, `project_id`, `stage_id` opcional) e marcar
quando foi recebida (`status: REQUESTED -> RECEIVED`), disparando os eventos de domínio
`material.requested` e `material.received`. **A integração completa com Estoque/Patrimônio**
(baixa real de saldo, devolução com movimento de estoque inverso, perda de material com
alçada de aprovação por faixa de valor) **é escopo do Marco 7** — ver nota de escopo cruzado
M6-53 no checklist. Este módulo apenas nasce a requisição e expõe o evento para o futuro
consumidor de Estoque integrar.

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
