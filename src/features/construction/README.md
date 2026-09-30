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

**Decisão**: em vez de inventar um schema de 16 tabelas sem base na fonte, o schema real deste
módulo usa **7 tabelas físicas**, fundindo entidades conceitualmente próximas em uma tabela
mais simples quando a fusão não perde nenhuma informação exigida pela fonte:

| Tabela física | Substitui (spec conceitual) | Motivo da fusão |
|---|---|---|
| `construction.projects` | `projects` | 1:1, sem fusão. |
| `construction.project_stages` | `project_stages` (+ `stage_dependencies`, ainda não implementado) | 1:1 nas colunas detalhadas pela fonte. |
| `construction.daily_reports` | `daily_logs` + `daily_workers` + `daily_materials` | O RDO real do dia é um único registro por `(project_id, report_date)` — equipe/materiais do dia cabem como campos/JSON do mesmo registro, evitando 3 tabelas para um conceito que a fonte também trata como um único "diário". |
| `construction.stage_measurements` | `measurements` + `measurement_items` | Medição deste módulo é por etapa (não por item de serviço detalhado) — um registro por medição cobre o que a fonte pede em `measuredPct`/status, sem a granularidade de itens que a fonte não chega a especificar campo-a-campo. |
| `construction.budget_lines` | `budgets` + `budget_items` | Orçamento é tratado como uma coleção de linhas soltas por centro de custo, sem um agregado "Budget" com status próprio — **conhecido como limitação** (ver M6-04/M6-17 no checklist: falta o estado `APPROVED`/baseline imutável agregado). |
| `construction.quality_checklist_items` | `quality_checks` | Checklist de qualidade por item, sem categorização por "tipo de obra" que a fonte cita em prosa mas não detalha em coluna. |
| `construction.maintenance_cases` | `warranty_cases` + `warranty_actions` | Caso de garantia e as ações tomadas dentro dele cabem em um único registro com histórico via auditoria (`registrarAuditoria`), em vez de duas tabelas — a fonte não especifica campos de `warranty_actions` além de "ações tomadas". |
| `construction.material_requests` | requisição mínima de material (M6-28) | Nova (não fundida) — ver seção abaixo. |

Esta fusão é uma decisão consciente de simplicidade sobre uma spec sem detalhe físico
completo, não uma omissão silenciosa. Onde a fusão deixa uma lacuna de negócio real (ex.:
baseline de orçamento imutável, dependências de etapa sem ciclo, itens de medição
detalhados), isso continua registrado como item aberto na Tabela-Mestre do checklist do Marco
6 — não é escondido por esta decisão de schema.

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

O Anexo I classifica Obras como **TIER 1** de disaster recovery (RPO/RTO intermediário), junto
com CRM, locação e estoque. **Decisão**: este módulo **não tem um mecanismo de backup/restore
próprio/dedicado** — ele é coberto pelo mecanismo geral de backup/restore do banco Postgres
inteiro (todas as 7 tabelas do schema `construction`, com RLS `ENABLE + FORCE` ativado,
participam do dump/restore do banco como qualquer outro schema do sistema). Isso é uma decisão
consciente, não uma lacuna: criar um mecanismo de backup separado por módulo adicionaria
complexidade operacional (múltiplos pontos de restore, risco de dessincronia entre schemas)
sem ganho real, já que o RPO/RTO do Tier 1 é perfeitamente atendível por um backup/restore de
banco completo bem operado (rotina de `pg_dump`/WAL archiving + teste periódico de restore,
mesmo mecanismo usado pelos demais módulos do sistema). Se no futuro Obras precisar de um RPO
mais agressivo que os demais módulos Tier 1, isso justificaria revisitar esta decisão — não há
indicação disso na fonte hoje.
