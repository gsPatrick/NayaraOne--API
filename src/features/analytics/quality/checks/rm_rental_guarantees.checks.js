'use strict';

/** M9-D696 (3.3) — checks do read model rm_rental_guarantees: frescor, conciliação com a fonte, invariante, completude de `ends_at` (exceto os tipos sem vencimento), duplicidade, faixa de linhas e valores não negativos. */
const { declareDomainChecks } = require('./domain.declare');
const { readNoExpiryGuaranteeTypes } = require('../../read-models/locacaoPrazosKpi.settings');

declareDomainChecks({
  model: 'rm_rental_guarantees', short: 'rental_guarantees', domain: 'RENTAL', metrics: ['rent.guarantees_expiring'],
  completeness: { field: 'ends_at', sql: `SELECT count(*)::int AS total, count(*) FILTER (WHERE ends_at IS NULL)::int AS nulls FROM legal.guarantees WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'ACTIVE' AND (ends_at IS NOT NULL OR guarantee_type NOT IN (:noExpiryTypes))`,
    replacements: async (ctx) => ({ noExpiryTypes: await readNoExpiryGuaranteeTypes(ctx.scope, ctx.transaction) }) }, // tipo sem vencimento (parâmetro do administrador) sem data não é falha de completude (M9-D641)
  invariant: { rule: 'vencendo em 30 dias <= vencendo em 60 dias', violation: `expiring_30d > expiring_60d` },
});
