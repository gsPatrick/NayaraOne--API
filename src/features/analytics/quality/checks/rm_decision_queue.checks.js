'use strict';

/**
 * M9-D696 (3.3) / M9-D709 — checks do read model rm_decision_queue: frescor, conciliação com a fonte, invariante (item decidido ou cancelado tem data da decisão, item
 * pendente não), completude de `created_at` (data do pedido) dos pedidos de aprovação financeira, duplicidade (kind + source_id e evento aplicado duas vezes), faixa de linhas e
 * valores não negativos.
 */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_decision_queue', short: 'decision_queue', domain: 'TECH_AI', metrics: ['fin.approvals_pending', 'inv.adjustments_pending', 'tec.rule_approvals_pending', 'ai.proposals_pending'],
  completeness: { field: 'created_at', sql: 'SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at IS NULL)::int AS nulls FROM finance.approval_requests WHERE company_id = :companyId' },
  invariant: { rule: 'item pendente sem data de decisão e item decidido ou cancelado com data', violation: "(status = 'PENDING' AND decided_at IS NOT NULL) OR (status <> 'PENDING' AND decided_at IS NULL)" },
});
