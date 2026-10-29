'use strict';

/** M9-D696 (3.3) / M9-D628 — checks do read model rm_ai_tool_calls: frescor, conciliação com a fonte, invariante, completude de `status`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_ai_tool_calls', short: 'ai_tool_calls', domain: 'TECH_AI', metrics: ['ai.tool_calls_blocked'],
  completeness: { field: 'status', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(status), '') IS NULL)::int AS nulls FROM ai.tool_calls WHERE company_id = :companyId` },
  invariant: { rule: 'bloqueadas <= chamadas', violation: `blocked > calls` },
});
