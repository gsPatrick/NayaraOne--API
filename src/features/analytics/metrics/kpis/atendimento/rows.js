'use strict';

/**
 * M9-D672 — leitura dos read models de Marketing e Atendimento para o cálculo dos KPIs de Atendimento. Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o
 * worker de read models gravou (M9-D607). Todos os KPIs são do mês de São Paulo da data-base (a chave `month` dos read models). As tabelas vêm das definições.
 */
const { sequelize } = require('../../../../../models');
const { DEFINITIONS } = require('./definitions');
const { latestSnapshotAt } = require('../legalCor/snapshotAt');

const T = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.metricCode, d.sourceReadModel])));

const select = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];
const PRIORITIES = ['alta', 'media', 'baixa'];

async function loadSupportRows(scope, asOfDate, settings, transaction) {
  const base = { companyId: scope.companyId, month: asOfDate.slice(0, 7) };
  const reviews = await select(
    `SELECT platform, reviews, rating_sum AS "ratingSum", rating_1 AS r1, rating_2 AS r2, rating_3 AS r3, rating_4 AS r4, rating_5 AS r5 FROM analytics.${T['sup.reviews']} WHERE company_id = :companyId AND month = :month ORDER BY platform`, base, transaction
  );
  const satisfaction = await select(`SELECT responses, score_sum AS "scoreSum", positive FROM analytics.${T['sup.satisfaction']} WHERE company_id = :companyId AND month = :month`, base, transaction);
  const complaints = await select(`SELECT reason, count FROM analytics.${T['sup.complaints_by_reason']} WHERE company_id = :companyId AND month = :month ORDER BY reason`, base, transaction);
  const [sla] = await select(
    `SELECT resolved, within_sla AS "withinSla", open_overdue AS "openOverdue", without_priority AS "withoutPriority", ${PRIORITIES.map((p) => `resolved_${p} AS "resolved_${p}", within_${p} AS "within_${p}"`).join(', ')}
       FROM analytics.${T['sup.sla_resolution']} WHERE company_id = :companyId AND month = :month`, base, transaction
  );
  const at = (code) => latestSnapshotAt(scope.companyId, [T[code]], transaction);
  return {
    reviews, satisfaction, complaints, sla: sla || null, month: base.month,
    snapshotAt: { 'sup.reviews': await at('sup.reviews'), 'sup.satisfaction': await at('sup.satisfaction'), 'sup.complaints_by_reason': await at('sup.complaints_by_reason'), 'sup.sla_resolution': await at('sup.sla_resolution') },
  };
}

module.exports = { loadSupportRows, SUPPORT_READ_MODELS: [...new Set(Object.values(T))] };
