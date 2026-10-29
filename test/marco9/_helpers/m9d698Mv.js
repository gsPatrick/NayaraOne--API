'use strict';

// Apoio da M9-D698 (materialized views): linhas mensais do rm_finance_health por conexão de superusuário, sem FK além das de empresa e grupo.
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');

const DAYS = [['2026-08-15', '100.00'], ['2026-08-31', '110.00'], ['2026-09-30', '120.00'], ['2026-10-10', '125.00'], ['2026-10-28', '130.00']];

async function setup() {
  const base = await sup.setup();
  await base.admin.query('DELETE FROM analytics.rm_finance_health WHERE company_id IN (:c)', { replacements: { c: [base.tenantA.companyId, base.tenantB.companyId] } });
  for (const [tenant, factor] of [[base.tenantA, 1], [base.tenantB, 2]]) {
    for (const [day, cash] of DAYS) {
      await base.admin.query(
        `INSERT INTO analytics.rm_finance_health (company_id, group_id, as_of_date, free_cash, receivables_30d, payables_30d, overdue_amount, source_snapshot_at)
         VALUES (:c, :g, :d, :cash, 10, 5, 1, now())`,
        { replacements: { c: tenant.companyId, g: tenant.groupId, d: day, cash: String(Number(cash) * factor) } }
      );
    }
  }
  return base;
}

async function teardown(env) {
  await env.admin.query('DELETE FROM analytics.rm_finance_health WHERE company_id IN (:c)', { replacements: { c: [env.tenantA.companyId, env.tenantB.companyId] } });
  await env.admin.query("DELETE FROM analytics.read_model_refreshes WHERE read_model LIKE 'mv\\_%'");
  await env.admin.query('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_m9d698_sem_indice');
  await env.admin.query('REFRESH MATERIALIZED VIEW analytics.mv_finance_health_monthly');
  await env.admin.close();
  await sequelize.close();
}

module.exports = { setup, teardown, inTx: sup.inTx, sequelize };
