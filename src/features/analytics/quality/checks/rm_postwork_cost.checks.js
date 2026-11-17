'use strict';

/** M9-D696 (3.3) — checks do read model rm_postwork_cost: frescor, conciliação com a fonte, invariante, completude de `root_cause_code`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

// DI-BI2-7 (item 5): a causa raiz é apurada durante o atendimento (M6:26, M6:66) e exigida no fechamento (maintenanceCases.service.js, que também não deixa retirá-la
// do chamado fechado): só o chamado CLOSED entra na conta.

declareDomainChecks({
  model: 'rm_postwork_cost', short: 'postwork_cost', domain: 'CONSTRUCTION', metrics: ['obra.postwork_cost'],
  completeness: { field: 'root_cause_code', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(root_cause_code), '') IS NULL)::int AS nulls FROM construction.maintenance_cases WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'CLOSED'` },
  invariant: { rule: 'casos abertos <= casos totais', violation: `cases_open > cases_total` },
});
