'use strict';

const { sequelize } = require('../../../models');

/**
 * Copia correspondent.integration_errors da empresa para a tabela genérica (M9-D207 regra 6). Idempotente: a linha nova
 * leva o MESMO id da antiga e `ON CONFLICT (id) DO NOTHING` ignora o que já foi copiado. `financing_case_id` vai para
 * `source_ref_id`, a operação é mantida e a origem é DISPATCH. A migration faz a mesma cópia para todas as empresas.
 */
const COPIA_SQL = `
INSERT INTO "integration"."integration_errors"
  (id, group_id, company_id, provider_code, source, source_ref_id, operation, error_class, error_code, severity,
   message, attempts, status, resolved_by, resolved_at, resolution_note, created_at)
SELECT l.id, l.group_id, l.company_id, l.provider_code, 'DISPATCH', l.financing_case_id, l.operation, 'UNKNOWN',
       l.error_code, 'MEDIUM', l.message, 1, l.status, l.resolved_by, l.resolved_at, left(l.resolution_note, 500), l.created_at
FROM "correspondent"."integration_errors" l
WHERE l.company_id = :companyId
ON CONFLICT (id) DO NOTHING
RETURNING id;
`;

async function migrateLegacyIntegrationErrors(ctx, transaction) {
  const [rows] = await sequelize.query(COPIA_SQL, { replacements: { companyId: ctx.companyId }, transaction });
  return { inserted: rows.length };
}

module.exports = { migrateLegacyIntegrationErrors };
