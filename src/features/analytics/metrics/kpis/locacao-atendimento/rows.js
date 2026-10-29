'use strict';

/**
 * M9-D642 — leitura dos read models de Locação para o cálculo dos KPIs de chamados, satisfação e repasses. Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o worker de
 * read models gravou (M9-D607). Chamados e repasses são o retrato da data-base; a satisfação é a linha do mês de São Paulo da data-base. As tabelas vêm das definições.
 */
const { sequelize } = require('../../../../../models');
const { DEFINITIONS } = require('./definitions');
const { latestSnapshotAt } = require('../legalCor/snapshotAt');

const T = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.metricCode, d.sourceReadModel])));

const select = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

async function loadRentalCareRows(scope, asOfDate, settings, transaction) {
  const base = { companyId: scope.companyId, asOf: asOfDate, month: asOfDate.slice(0, 7) };
  const [tickets] = await select(
    `SELECT open_total AS "openTotal", opened_period AS "openedPeriod", closed_period AS "closedPeriod", resolution_hours_period AS "hoursPeriod", without_open_date AS "withoutOpenDate"
       FROM analytics.${T['rent.tickets']} WHERE company_id = :companyId AND as_of_date = :asOf`, base, transaction
  );
  const [satisfaction] = await select(
    `SELECT responses, score_sum AS "scoreSum", tenant_responses AS "tenantResponses", tenant_score_sum AS "tenantScoreSum", owner_responses AS "ownerResponses", owner_score_sum AS "ownerScoreSum"
       FROM analytics.${T['rent.satisfaction']} WHERE company_id = :companyId AND month = :month`, base, transaction
  );
  const [repasses] = await select(
    `SELECT pending, paid, overdue, pending_count AS "pendingCount", paid_count AS "paidCount", overdue_count AS "overdueCount", due_count AS "dueCount", on_time_count AS "onTimeCount",
            without_due_date AS "withoutDueDate" FROM analytics.${T['rent.repasses']} WHERE company_id = :companyId AND as_of_date = :asOf`, base, transaction
  );
  const at = (code) => latestSnapshotAt(scope.companyId, [T[code]], transaction);
  return {
    tickets: tickets || null, satisfaction: satisfaction || null, repasses: repasses || null,
    snapshotAt: { 'rent.tickets': await at('rent.tickets'), 'rent.satisfaction': await at('rent.satisfaction'), 'rent.repasses': await at('rent.repasses') },
  };
}

module.exports = { loadRentalCareRows, RENTAL_CARE_READ_MODELS: [...new Set(Object.values(T))] };
