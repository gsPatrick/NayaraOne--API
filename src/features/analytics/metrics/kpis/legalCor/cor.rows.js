'use strict';

/**
 * M9-D661 — leitura dos read models do Correspondente para o cálculo dos KPIs. Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o
 * worker de read models gravou (M9-D607). Aprovação e tempo de análise leem o mês de São Paulo da data-base; estágio e comissão são agregados da
 * empresa inteira. As tabelas vêm das definições.
 */
const { sequelize } = require('../../../../../models');
const { DEFINITIONS } = require('./cor.definitions');
const { latestSnapshotAt } = require('./snapshotAt');

const T = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.metricCode, d.sourceReadModel])));

const select = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

async function loadCorRows(scope, asOfDate, settings, transaction) {
  const base = { companyId: scope.companyId, month: asOfDate.slice(0, 7) };
  const stages = await select(`SELECT stage, count, days_in_stage_sum AS "daysSum" FROM analytics.${T['cor.cases_by_stage']} WHERE company_id = :companyId ORDER BY stage`, base, transaction);
  const outcome = await select(
    `SELECT provider, product, approved, rejected, analysis_count AS "analysisCount", analysis_days_sum AS "daysSum" FROM analytics.${T['cor.approval_rate_by_provider']}
      WHERE company_id = :companyId AND period_month = :month ORDER BY provider, product`, base, transaction
  );
  const commission = await select(
    `SELECT provider, expected::text AS expected, confirmed::text AS confirmed, received::text AS received, received_unlinked AS "receivedUnlinked"
       FROM analytics.${T['cor.commission']} WHERE company_id = :companyId ORDER BY provider`, base, transaction
  );
  const at = (...codes) => latestSnapshotAt(scope.companyId, codes.map((c) => T[c]), transaction);
  return {
    stages, outcome, commission, month: base.month,
    snapshotAt: {
      'cor.cases_by_stage': await at('cor.cases_by_stage'), 'cor.approval_rate_by_provider': await at('cor.approval_rate_by_provider'),
      'cor.analysis_time': await at('cor.analysis_time', 'cor.cases_by_stage'), 'cor.commission': await at('cor.commission'),
    },
  };
}

module.exports = { loadCorRows, COR_READ_MODELS: [...new Set(Object.values(T))] };
