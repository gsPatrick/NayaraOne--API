'use strict';

/** M9-D696 (3.3) / M9-D628 — checks do read model rm_ai_quality: frescor, conciliação com a fonte, invariante, completude de `grounding_status`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_ai_quality', short: 'ai_quality', domain: 'TECH_AI', metrics: ['ai.quality_scores'],
  completeness: { field: 'grounding_status', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE NULLIF(btrim(grounding_status), '') IS NULL)::int AS nulls FROM ai.ai_runs WHERE company_id = :companyId` },
  invariant: { rule: 'pontuação <= unidades medidas e execuções fundamentadas <= execuções', violation: `grounding_runs > runs OR grounding_score_sum > grounding_runs OR eval_score_sum > eval_items` },
});
