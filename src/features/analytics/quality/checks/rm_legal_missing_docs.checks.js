'use strict';

/** M9-D696 (3.3) — checks do read model rm_legal_missing_docs: frescor, conciliação com a fonte, invariante, completude de `requirement_type`, duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');

declareDomainChecks({
  model: 'rm_legal_missing_docs', short: 'legal_missing_docs', domain: 'LEGAL', metrics: ['legal.missing_documents'],
  completeness: { field: 'requirement_type', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE requirement_type IS NULL)::int AS nulls FROM legal.contract_requirements WHERE company_id = :companyId AND status = 'PENDING'` },
  invariant: { rule: 'contratos com falta <= exigências pendentes', violation: `contracts_missing > requirements_pending` },
});
