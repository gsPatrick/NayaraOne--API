'use strict';

/**
 * M9-D641 — leitura dos read models de Locação para o cálculo dos KPIs de prazos. Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o worker de read models gravou
 * (M9-D607). Garantias e obrigações são o estado atual da carteira; vistorias e chaves, o retrato da data-base. As tabelas vêm das definições.
 */
const { sequelize } = require('../../../../../models');
const { DEFINITIONS } = require('./definitions');
const { latestSnapshotAt } = require('../legalCor/snapshotAt');

const T = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.metricCode, d.sourceReadModel])));

const select = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

async function loadRentalDeadlineRows(scope, asOfDate, settings, transaction) {
  const base = { companyId: scope.companyId, asOf: asOfDate };
  const guarantees = await select(
    `SELECT type, expiring_30d AS "expiring30", expiring_60d AS "expiring60", expired, without_date AS "withoutDate" FROM analytics.${T['rent.guarantees_expiring']} WHERE company_id = :companyId ORDER BY type`, base, transaction
  );
  const obligations = await select(
    `SELECT kind, pending, overdue, without_deadline AS "withoutDeadline", oldest_overdue_days AS "oldestOverdueDays" FROM analytics.${T['rent.obligations_pending']} WHERE company_id = :companyId ORDER BY kind`, base, transaction
  );
  const [inspections] = await select(
    `SELECT inspections_pending AS "inspectionsPending", inspections_overdue AS "inspectionsOverdue", keys_out AS "keysOut", keys_return_overdue AS "keysReturnOverdue",
            keys_without_return_date AS "keysWithoutReturnDate" FROM analytics.${T['rent.inspections_keys']} WHERE company_id = :companyId AND as_of_date = :asOf`, base, transaction
  );
  const at = (code) => latestSnapshotAt(scope.companyId, [T[code]], transaction);
  return {
    guarantees, obligations, inspections: inspections || null,
    snapshotAt: { 'rent.guarantees_expiring': await at('rent.guarantees_expiring'), 'rent.obligations_pending': await at('rent.obligations_pending'), 'rent.inspections_keys': await at('rent.inspections_keys') },
  };
}

module.exports = { loadRentalDeadlineRows, RENTAL_DEADLINE_READ_MODELS: [...new Set(Object.values(T))] };
