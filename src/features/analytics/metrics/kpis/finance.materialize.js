'use strict';

/**
 * M9-D624 (3, 5 e 6) — calcula os KPIs fin.reconciliations_pending e fin.anomalies_open da empresa a partir do read model rm_finance_health
 * (nunca do OLTP) com a fórmula versionada do código, e grava o snapshot da data-base com status, hash do cálculo e sourceRefs (M9-D611).
 * Roda na transação do refresh do read model (escritor do BI ligado), depois que o read model foi gravado. Sem escrita fora do schema analytics.
 * `financeKpiCorrections` é o gancho do rebuild do rm_finance_health (M9-D608): refaz o número de cada data-base que já tem snapshot.
 */
const { sequelize } = require('../../../../models');
const store = require('../../metricStore.service');
const { ensureFinanceKpisPublished } = require('./finance.register');
const { buildFinanceKpiEntries } = require('./finance.entries');
const { writeSnapshotInputs } = require('./finance.snapshots');
const { KPI_DEFINITIONS, SOURCE_READ_MODEL } = require('./finance.definitions');

/** Pode ser chamado de novo para a mesma data-base: só entra revisão se algo mudou. Devolve { kpis: { código: resultado }, written }. */
async function materializeFinanceKpis(scope, asOfDate, transaction) {
  const [rows] = await sequelize.query(`SELECT 1 FROM analytics.${SOURCE_READ_MODEL} WHERE company_id = :c AND as_of_date = :d`, { replacements: { c: scope.companyId, d: asOfDate }, transaction });
  if (!rows.length) return { kpis: {}, written: 0 };
  await store.enableAnalyticsWriter(transaction);
  await ensureFinanceKpisPublished(scope, transaction);
  const out = { kpis: {}, written: 0 };
  for (const entry of await buildFinanceKpiEntries(scope, asOfDate, transaction)) {
    out.written += await writeSnapshotInputs(entry.inputs, transaction);
    out.kpis[entry.code] = entry.result;
  }
  return out;
}

/** rebuild.corrections do rm_finance_health: entradas de snapshot das datas-base que já têm snapshot dos KPIs (o rebuild só revisa o que mudou). */
async function financeKpiCorrections({ companyId, groupId, transaction }) {
  const [dates] = await sequelize.query(
    `SELECT DISTINCT s.as_of_date::text AS as_of_date FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
      WHERE s.company_id = :companyId AND d.metric_code IN (:codes) ORDER BY 1`,
    { replacements: { companyId, codes: KPI_DEFINITIONS.map((d) => d.metricCode) }, transaction }
  );
  const inputs = [];
  for (const { as_of_date: asOfDate } of dates) {
    for (const entry of await buildFinanceKpiEntries({ companyId, groupId }, asOfDate, transaction)) inputs.push(...entry.inputs);
  }
  return inputs;
}

module.exports = { materializeFinanceKpis, financeKpiCorrections };
