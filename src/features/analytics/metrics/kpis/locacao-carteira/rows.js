'use strict';

/**
 * M9-D640 — leitura dos read models de Locação para o cálculo dos KPIs da carteira. Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o worker de read models gravou
 * (M9-D607). Contratos são o estado atual por situação; vacância e inadimplência, o retrato da data-base. As tabelas vêm das definições.
 */
const { sequelize } = require('../../../../../models');
const { DEFINITIONS } = require('./definitions');
const { latestSnapshotAt } = require('../legalCor/snapshotAt');

const T = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.metricCode, d.sourceReadModel])));
const select = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

async function loadRentalPortfolioRows(scope, asOfDate, settings, transaction) {
  const base = { companyId: scope.companyId, asOf: asOfDate };
  const contracts = await select(
    `SELECT status, count, rent_total::text AS "rentTotal", without_rent AS "withoutRent", by_property AS "byProperty", by_owner AS "byOwner", rent_distribution AS "rentDistribution"
       FROM analytics.${T['rent.active_contracts']} WHERE company_id = :companyId ORDER BY status`, base, transaction
  );
  const [vacancy] = await select(
    `SELECT rentable_total AS "rentableTotal", rented_total AS "rentedTotal", suspended_total AS "suspendedTotal", vacant_total AS "vacantTotal", status_undefined AS "statusUndefined",
            by_type AS "byType", by_neighborhood AS "byNeighborhood", by_owner AS "byOwner" FROM analytics.${T['rent.vacancy']} WHERE company_id = :companyId AND as_of_date = :asOf`, base, transaction
  );
  const [arrears] = await select(
    `SELECT billed_90d::text AS billed, overdue_amount::text AS "overdueAmount", overdue_amount_in_window_90d::text AS "inWindow", overdue_amount_outside_window_90d::text AS outside,
            without_due_date AS "withoutDueDate", unlinked_amount::text AS "unlinkedAmount", unlinked_count AS "unlinkedCount", by_age AS "byAge", by_contract AS "byContract", by_property AS "byProperty"
       FROM analytics.${T['rent.delinquency']} WHERE company_id = :companyId AND as_of_date = :asOf`, base, transaction
  );
  const at = (code) => latestSnapshotAt(scope.companyId, [T[code]], transaction);
  return {
    contracts, vacancy: vacancy || null, arrears: arrears || null,
    snapshotAt: { 'rent.active_contracts': await at('rent.active_contracts'), 'rent.vacancy': await at('rent.vacancy'), 'rent.delinquency': await at('rent.delinquency') },
  };
}

module.exports = { loadRentalPortfolioRows, RENTAL_PORTFOLIO_READ_MODELS: [...new Set(Object.values(T))] };
