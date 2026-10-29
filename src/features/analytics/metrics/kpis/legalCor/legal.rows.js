'use strict';

/**
 * M9-D660 — leitura dos read models do Jurídico para o cálculo dos KPIs. Só lê o schema analytics (nunca o OLTP): o valor sai do estado que o worker
 * de read models gravou (M9-D607). O prazo lê a linha da data-base; os demais são agregados da empresa inteira. As tabelas vêm das definições.
 */
const { sequelize } = require('../../../../../models');
const { DEFINITIONS } = require('./legal.definitions');
const { latestSnapshotAt } = require('./snapshotAt');

const T = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.metricCode, d.sourceReadModel])));

const select = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

async function loadLegalRows(scope, asOfDate, settings, transaction) {
  const base = { companyId: scope.companyId, asOfDate };
  const deadlines = (await select(`SELECT * FROM analytics.${T['legal.deadlines']} WHERE company_id = :companyId AND as_of_date = :asOfDate`, base, transaction))[0] || null;
  const risk = await select(`SELECT risk_level AS risk, case_type AS type, count FROM analytics.${T['legal.cases_by_risk']} WHERE company_id = :companyId ORDER BY risk_level, case_type`, base, transaction);
  const values = await select(
    `SELECT case_type AS type, risk_level AS risk, estimated_total::text AS estimated, confirmed_total::text AS confirmed, cases_without_value AS "withoutValue"
       FROM analytics.${T['legal.values']} WHERE company_id = :companyId ORDER BY case_type, risk_level`, base, transaction
  );
  const docs = await select(
    `SELECT requirement_type AS type, contracts_missing AS contracts, requirements_pending AS requirements, requirements_without_deadline AS "withoutDeadline"
       FROM analytics.${T['legal.missing_documents']} WHERE company_id = :companyId ORDER BY requirement_type`, base, transaction
  );
  const at = (code) => latestSnapshotAt(scope.companyId, [T[code]], transaction);
  return {
    deadlines, risk, values, docs,
    snapshotAt: {
      'legal.deadlines': deadlines ? deadlines.source_snapshot_at && new Date(deadlines.source_snapshot_at) : null,
      'legal.cases_by_risk': await at('legal.cases_by_risk'), 'legal.values': await at('legal.values'), 'legal.missing_documents': await at('legal.missing_documents'),
    },
  };
}

module.exports = { loadLegalRows, LEGAL_READ_MODELS: Object.values(T) };
