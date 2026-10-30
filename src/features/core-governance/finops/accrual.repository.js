'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');

/** Soma o uso na hora (UPSERT atômico): quantidade, chamadas, tokens e custo fracionário (centavos x 1e6). */
async function addUsage(tenant, a, transaction) {
  await sequelize.query(
    `INSERT INTO governance.cost_accruals (group_id, company_id, environment, domain, category, service, hour_start, usage_quantity, usage_unit, calls, tokens_in, tokens_out, cost_scaled)
     VALUES (:groupId, :companyId, :environment, :domain, :category, :service, :hourStart, :quantity, :unit, :calls, :tokensIn, :tokensOut, :costScaled)
     ON CONFLICT (company_id, environment, domain, category, service, hour_start) DO UPDATE SET
       usage_quantity = governance.cost_accruals.usage_quantity + EXCLUDED.usage_quantity, calls = governance.cost_accruals.calls + EXCLUDED.calls,
       tokens_in = governance.cost_accruals.tokens_in + EXCLUDED.tokens_in, tokens_out = governance.cost_accruals.tokens_out + EXCLUDED.tokens_out,
       cost_scaled = governance.cost_accruals.cost_scaled + EXCLUDED.cost_scaled, updated_at = clock_timestamp()`,
    { transaction, replacements: { groupId: tenant.groupId, companyId: tenant.companyId, tokensIn: 0, tokensOut: 0, calls: 1, ...a } }
  );
}

/** Horas já fechadas (hour_start + 1 h <= agora) ainda não consolidadas ou alteradas depois da consolidação. */
async function listClosable(tenant, now, categories, transaction) {
  return sequelize.query(
    `SELECT id, environment, domain, category, service, hour_start, usage_quantity::text AS usage_quantity, usage_unit, calls, tokens_in, tokens_out, cost_scaled::text AS cost_scaled
       FROM governance.cost_accruals
      WHERE company_id = :companyId AND category IN (:categories) AND hour_start + interval '1 hour' <= :now AND (consolidated_at IS NULL OR updated_at > consolidated_at)
      ORDER BY hour_start, category, service FOR UPDATE`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, now, categories } }
  );
}

async function markConsolidated(ids, transaction) {
  if (!ids.length) return;
  await sequelize.query('UPDATE governance.cost_accruals SET consolidated_at = clock_timestamp() WHERE id IN (:ids)', { transaction, replacements: { ids } });
}

module.exports = { addUsage, listClosable, markConsolidated };
